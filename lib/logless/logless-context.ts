import * as https from "https";
import * as util from "util";
import {Logless} from "./logless";
const uuid = require("uuid");

export class LoglessContext {
    private _callback: Function;
    private _queue: Array<Log> = [];
    private _transactionID: string;
    private _uncaughtExceptionHandler: Function;

    public constructor(private _source: string) {

    }

    private wrapCall(console: any, name: string, type: LogType): void {
        const self = this;
        let originalCall = (<any> console)[name];
        if (!this.usesContinuationLocalStorage() && originalCall.logless !== undefined) {
            return originalCall;
        }

        let newCall: any = function (data: any) {
            let args = Array.prototype.slice.call(arguments);
            if (args.length > 1) {
                args = args.slice(1);
            } else {
                args = null;
            }

            let context = self;
            // If we are using continuation local storage, need to get logging context from there
            if (self.usesContinuationLocalStorage()) {
                context = require("continuation-local-storage").getNamespace("Logless").get("context");
                if (context) {
                    context.log(type, data, args);
                }
            } else {
                context.log(type, data, args);
            }


            // Need to put it all into one array and call the function or the params are not processed correctly
            originalCall.apply(this, arguments);
        };

        // Add a property to the call if this is not using continuation local storage
        //  i.e., if this is a Lambda
        if (!this.usesContinuationLocalStorage()) {
            newCall.logless = true;
        }
        console[name] = newCall;
    }

    /**
     * Uses continuation local storage module to do a ThreadLocal like deal on the console
     * That way we can associate the logs with the particular transaction
     */
    public wrapConsole(): void {
        require("continuation-local-storage").createNamespace("Logless");

        this.wrapCall(console, "error", LogType.ERROR);
        this.wrapCall(console, "info", LogType.INFO);
        this.wrapCall(console, "log", LogType.DEBUG);
        this.wrapCall(console, "warn", LogType.WARN);
    }

    /**
     *
     * @param routine For wrapped consoles, needs to start at the top of the callback tree, so it is passed in
     * @returns {any}
     */
    public captureConsole(routine: Function): any {
        let namespace = require("continuation-local-storage").getNamespace("Logless");

        let self = this;
        namespace.run(function () {
            namespace.set("context", self);
            routine();
        });
    }

    public onLambdaEvent(event: any, context: any, wrappedCallback: Function): void {
        const self = this;
        this._transactionID = uuid.v4();

        this.wrapCall(console, "error", LogType.ERROR);
        this.wrapCall(console, "info", LogType.INFO);
        this.wrapCall(console, "log", LogType.DEBUG);
        this.wrapCall(console, "warn", LogType.WARN);

        this._uncaughtExceptionHandler = function (error: Error) {
            // In the case of an uncaught exception, we log it and then flush
            // This can then lead to multiple flushes, but we don't want to lose the logs if this exception
            //  caused the program to not return successfully
            console.error(error);
            self.flush();
        };

        process.on("uncaughtException", this._uncaughtExceptionHandler);

        const done = context.done;
        context.done = function(error: any, result: any) {
            self.captureResponse(error, result);
            self.flush(function () {
                self.cleanup();
                done.call(context, error, result);
            });
        };

        // Capture the request event
        this.log(LogType.INFO, event, null, ["request"]);

        if (wrappedCallback !== undefined && wrappedCallback !== null) {
            this._callback = function(error: any, result: any) {
                self.captureResponse(error, result);
                self.flush(function () {
                    self.cleanup();
                    wrappedCallback.call(this, error, result);
                });
            };
        }
    }

    public callback(): Function {
        return this._callback;
    }

    public log(type: LogType, data: any, params?: Array<any>, tags?: Array<string>) {
        // If this is a an error, do special handling
        if (data instanceof Error) {
            this.logError(type, <Error> data, tags);

        } else if (typeof data === "string") {
            // For strings, we do string formatting for macros if they exist
            let dataString = data;
            if (params !== undefined && params !== null) {
                // Apply the string formatting
                let allParams = [data];
                for (let param of params) {
                    allParams.push(param);
                }
                dataString = util.format.apply(this, allParams);
            }
            this._queue.push(new Log(type, dataString, null, tags));

        } else {
            if (data === undefined) {
                data = null;
            }
            this._queue.push(new Log(type, data, null, tags));

        }
    }

    public logError(type: LogType, error: any, tags?: Array<string>) {
        let message = error.name + ": " + error.message;
        if (error.code !== undefined) {
            message += " code: " + error.code;
        }

        if (error.syscall !== undefined) {
            message += " syscall: " + error.syscall;
        }
        this._queue.push(new Log(type, message, error.stack, tags));
    }

    private captureResponse(error: Error, result: any) {
        if (error !== undefined && error !== null) {
            this.log(LogType.ERROR, error, null, ["response"]);
        } else {
            this.log(LogType.INFO, result, null, ["response"]);
        }
    }

    public transactionID(): string {
        return this._transactionID;
    }

    public cleanup(): void {
        process.removeListener("uncaughtException", this._uncaughtExceptionHandler);
    }

    public flush(flushed?: () => void) {
        if (!this._transactionID) {
            this._transactionID = uuid.v4();
        }

        const logBatch = {
            source: this._source,
            transaction_id: this.transactionID(),
            logs: new Array()
        };

        for (let log of this._queue) {
            const timestamp = log.timestampAsISOString();
            const logJSON: any = {
                payload: log.data,
                log_type: LogType[log.type],
                timestamp: timestamp,
            };

            if (log.tags !== undefined && log.tags !== null) {
                logJSON.tags = log.tags;
            }

            if (log.stack !== undefined && log.stack !== null) {
                logJSON.stack = log.stack;
            }

            logBatch.logs.push(logJSON);
        }

        this.transmit(logBatch, flushed);

        // Clear the queue
        this._queue = [];
    }

    public transmit(logBatch: any, flushed?: () => void)  {
        const dataAsString = JSON.stringify(logBatch);
        const dataLength = Buffer.byteLength(dataAsString);
        const options = {
            // host: "logless.io",
            host: Logless.Domain,
            path: "/v1/receive",
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Content-Length": dataLength,
                "Connection": "keep-alive"
            }
        };

        console.time("Logless.FlushTime");
        const httpRequest = https.request(options);

        httpRequest.on("error", function(error: Error) {
            console.error(error.toString());
            if (flushed !== undefined) {
                console.timeEnd("Logless.FlushTime");
                console.log("Flushed Logs: " + logBatch.logs.length);
                flushed();
            }
        });

        httpRequest.setNoDelay(true);
        httpRequest.end(dataAsString, null, function () {
            if (flushed !== undefined) {
                console.timeEnd("Logless.FlushTime");
                console.log("Flushed Logs: " + logBatch.logs.length);
                flushed();
            }
        });
    }

    private usesContinuationLocalStorage (): boolean {
        return (<any> process).namespaces !== undefined;
    }
}

export enum LogType {
    DEBUG,
    ERROR,
    INFO,
    WARN,
}

export class Log {
    public _timestamp: Date;

    public constructor(public type: LogType, public data: any, public stack?: string, public tags?: Array<string>) {
        this._timestamp = new Date();
    }

    public timestampAsISOString(): string {
        return this._timestamp.toISOString();
    }
}

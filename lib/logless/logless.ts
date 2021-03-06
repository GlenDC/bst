import {LoglessContext} from "../logless/logless-context";
import {Response} from "~express/lib/response";
import {LogType} from "./logless-context";
import {RequestHandler} from "~express/lib/router/index";
import {ErrorHandler} from "~express/lib/express";

/**
 * Logless will automatically capture logs and diagnostics for your Node.js Lambda or Express.js service.
 *
 * To use it with Lambdas, simply wrap your function handler, like so:
 * <pre><code>
 *     var bst = require('bespoken-tools');
 *
 *     exports.handler = bst.Logless.capture("&lt;SECRET_KEY&gt;", function (event, context) {
 *         // Lambda code goes here
 *         context.done(null, "Hello World");
 *     });
 *
 * </code></pre>
 *
 * To use it with Express.js, simply wrap configure it with your routes.
 * <pre><code>
 *     var bst = require('bespoken-tools');
 *
 *     var logless = bst.Logless.middleware("&lt;SECRET_KEY&gt;");
 *     app = express();
 *
 *     app.use(bodyParser.json());
 *     app.use(logless.requestHandler);
 *
 *     // Application handlers and routers registered here
 *     app.post("/", function {
 *         ...
 *     });
 *
 *     // The Logless error handler must be registered last
 *     app.use(logless.errorHandler);
 *
 * </code></pre>
 *
 * That's all there is to it. Then you can see all your logs through our handy dashboard!
 *
 * We will effortlessly capture and format:
 * <ul>
 *     <li>Request and response payloads
 *     <li>Console output (including instrumentation for timing and all debug levels)
 *     <li>Error and stack traces
 * </ul>
 *
 */
export class Logless {
    public static Domain: string = "logless.bespoken.tools";
    private static captureConsole: boolean = false;

    /**
     * Wraps an AWS Lambda function to capture logs and diagnostics
     * @param source The secret key for your Logless app
     * @param handler
     * @returns {LambdaFunction}
     */
    public static capture(source: string, handler: LambdaFunction): LambdaFunction {
        if (handler === undefined || handler === null) {
            throw new Error("Handler is null or undefined! This must be passed.");
        }

        return new LambdaWrapper(source, handler).lambdaFunction();
    }

    /**
     * Returns an object to hold handlers for use in capturing logs and diagnostics with Express.js
     * @param source The secret key for your Logless app
     * @returns {LoglessMiddleware}
     */
    public static middleware(source: string): LoglessMiddleware {
        const context = new LoglessContext(source);
        if (Logless.captureConsole) {
            context.wrapConsole();
        }

        const capturePayloads = function (request: any, response: Response, next: Function) {
            context.log(LogType.INFO, request.body, null, ["request"]);

            Logless.wrapResponse(context, response);
            if (Logless.captureConsole) {
                context.captureConsole(function () {
                    next();
                });
            } else {
                next();
            }
        };

        const captureError = function(error: Error, request: any, response: Response, next: Function) {
            context.logError(LogType.ERROR, error, null);
            next();
        };

        // Set the logger on the request handler for testability
        (<any> capturePayloads).logger = context;
        (<any> captureError).logger = context;
        return new LoglessMiddleware(capturePayloads, captureError);
    }

    /**
     * Experimental - this uses monkey-patching to trace console output associated with a transaction on ExpressJS
     * The logs that come back associated with a particular log conversation should not be considered completely reliable
     *  at this point.
     * ONLY necessary for ExpressJS.
     */
    public static enableConsoleLogging() {
        // Enables capture of console output
        Logless.captureConsole = true;
    }

    public static disableConsoleLogging() {
        // Enables capture of console output
        Logless.captureConsole = false;
    }

    private static wrapResponse(context: LoglessContext, response: Response, onFlushed?: Function): void {
        const originalEnd = response.end;
        (<any> response).end = (data: any, encoding?: string, callback?: Function): void => {
            let payload = data.toString();
            if (response.getHeader("content-type").startsWith("application/json")) {
                try {
                    payload = JSON.parse(payload);
                } catch (e) {
                    console.error("Could not parse JSON: " + payload);
                }
            }

            context.log(LogType.INFO, payload, null, ["response"]);
            originalEnd.call(response, data, encoding, callback);
            context.flush();
        };
    }
}

export class LoglessMiddleware {
    public constructor (public requestHandler: RequestHandler, public errorHandler: ErrorHandler) {}
}

/**
 * Interface for AWS Node.js Lambda signature
 */
export interface LambdaFunction {
    (event: any, context: any, callback?: (error?: Error, result?: any) => void): void;
}

/**
 * Wraps the lambda function
 */
class LambdaWrapper {

    public constructor (private source: string, public wrappedLambda: LambdaFunction) {}

    public handle(event: any, context: any, callback?: Function): void {
        // Create a new logger for this context
        const logger = new LoglessContext(this.source);
        context.logger = logger;
        logger.onLambdaEvent(event, context, callback);

        try {
            this.wrappedLambda.call(this, event, context, logger.callback());
        } catch (e) {
            console.error(e);
            logger.flush();
            logger.cleanup();
        }
    }

    public lambdaFunction(): LambdaFunction {
        let lambda = this.handle.bind(this);
        return lambda;
    }
}

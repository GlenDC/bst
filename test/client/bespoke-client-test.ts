/// <reference path="../../typings/index.d.ts" />

import * as assert from "assert";

import {BespokeClient} from "../../lib/client/bespoke-client";
import {Node} from "../../lib/server/node";
import {NodeManager} from "../../lib/server/node-manager";
import {Global} from "../../lib/core/global";
import {KeepAlive} from "../../lib/client/keep-alive";
import {SocketHandler} from "../../lib/core/socket-handler";
import {HTTPClient} from "../../lib/core/http-client";

let keepAlive: KeepAlive = null;
class MockBespokeClient extends BespokeClient {
    protected newKeepAlive(handler: SocketHandler): KeepAlive {
        keepAlive = new KeepAlive(handler);
        keepAlive.pingPeriod = 20;
        keepAlive.warningThreshold = 10;
        keepAlive.windowPeriod = 400;
        return keepAlive;
    }
}

// Much of the testing for this class is done by NodeManager, the other side of its interface
// These tests related to the keep alive, which are tricky to write
// I believe they are worth it because this is critical functionality to our robustness
describe("BespokeClient", function() {

    describe("#connect()", function() {
        it("Fails to connect", function(done) {
            let client = new BespokeClient("JPK", "localhost", 9000, "localhost", 9001);
            client.onConnect = function (error: any) {
                assert(error);
                done();
            };
            client.connect();
        });

        it("Connects to something other than localhost", function(done) {
            let client = new BespokeClient("JPK", "proxy.bespoken.tools", 5000, "0.0.0.0", 9001);
            client.onConnect = function (error: any) {
                let webhookCaller = new HTTPClient();
                webhookCaller.post("proxy.bespoken.tools", 80, "/test?node-id=JPK", "Test", function (data: Buffer, statusCode: number, success: boolean) {
                    assert.equal(data.toString(), "BST Proxy - Local Forwarding Error\nconnect ECONNREFUSED 0.0.0.0:9001");
                    assert.equal(statusCode, 500);

                    client.shutdown(function () {
                        done();
                    });
                });
            };

            client.onError = function (errorType, message) {
                // We expect an error - make sure it contains the correct domain name
                assert(message.indexOf("0.0.0.0") !== -1);
            };

            client.connect();
        });
    });

    describe("KeepAlive worked", function() {
        it("Gets lots of keep alives", function(done) {
            let nodeManager = new NodeManager(9000);
            let count = 0;
            (<any> NodeManager).onKeepAliveReceived = function (node: Node) {
                count++;
                node.socketHandler.send(Global.KeepAliveMessage);
            };

            let client = new MockBespokeClient("JPK", "localhost", 9000, "localhost", 9001);
            nodeManager.start();
            client.connect();

            let originalCallback = (<any> keepAlive).onFailureCallback;
            (<any> keepAlive).onFailureCallback = function () {
                originalCallback();
                assert(false, "This callback should not be hit");
            };

            // Let everything run for one second and ensure no errors are received
            setTimeout(function () {
                if (count < 40) {
                    assert(false, "Not enough keep alives received");
                }
                client.shutdown(function () {
                    nodeManager.stop(function () {
                        done();
                    });
                });
            }, 1000);
        });
    });

    describe("KeepAlive failed", function() {
        it("Fails", function(done) {
            let nodeManager = new NodeManager(9000);
            let count = 0;
            (<any> NodeManager).onKeepAliveReceived = function (node: Node) {
                count++;
                if (count < 10) {
                    node.socketHandler.send(Global.KeepAliveMessage);
                }
            };

            let client = new MockBespokeClient("JPK", "localhost", 9000, "localhost", 9001);
            nodeManager.start();
            client.connect();

            let originalCallback = (<any> keepAlive).onFailureCallback;
            let failureCount = 0;
            (<any> keepAlive).onFailureCallback = function () {
                originalCallback();
                failureCount++;
            };

            setTimeout(function () {
                console.log("Count: " + count + " Failures: " + failureCount);

                if (failureCount > 2) {
                    assert(false, "Too many failures received");
                }

                client.shutdown(function () {
                    nodeManager.stop(function () {
                        done();
                    });
                });

            }, 1000);
        });
    });

});

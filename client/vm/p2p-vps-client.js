/*
  This is the primary 'governor' application that drives a Client device and allows it to communicate
  with a P2P VPS Server. The scope of this application covers:

  * It reads the device-config.json file and registers the Client device with the P2P VPS server.

  * It builds the Docker container with information returned by the server after registration.

  * It launches the Docker container after being built.

  * It sends a heartbeat signal to the P2P VPS server every 10 minutes. The server responds with an
  expiration date.
    * (Maybe I can also send benchmark data to the server?)

  * When the expiration date is reached, or the Server can not be reached after 30 minutes, the governor
  software stops the Docker container and wipes the flash drive. It then reregisters itself with the
  P2P VPS marketplace.

  * If the Client can not make contact with the Server, it quietly retries to make contact every 2 minutes.

  Specifications for this program can be found here:
  https://github.com/P2PVPS/p2pvps-server/blob/master/specifications/client-specification.md
*/

/*
 * Copyright 2017 Chris Troutner & P2PVPS.org
 * MIT License. See LICENSE.md for details.
 */

//This file registers with the server
"use strict";

/*
 * Express Dependencies
 */
const express = require("express");
//const fs = require("fs");
//const http = require("http"); //Used for GET and POST requests
//const request = require("request"); //Used for CURL requests.
//const rp = require("request-promise");
const getStream = require("get-stream");
//var Promise = require('node-promise');
//const exec = require("child_process").exec; //Used to execute command line instructions.
const execa = require("execa");

const app = express();
const port = 4000;
let checkExpirationTimer;

/*
 * Global Variables
 */

//Dev Note: I should make debugState a local varible in each library, so that I can turn debugging on
//for specific features data logging, server interface, etc.
global.debugState = true; //Used to turn verbose debugging off or on.

// Read in device-config.json file
let deviceConfig;
try {
  deviceConfig = require("./device-config.json");
  console.log(`Registering device ID ${deviceConfig.deviceId}`);
} catch (err) {
  console.error("Could not open the device-config.json file! Exiting.", err);
  process.exit(1);
}

// Each type of client shell will have a unique write-files.js library.
const WriteFiles = require("./lib/write-files.js");
const writeFiles = new WriteFiles(deviceConfig);

// Utility functions for dealing with the P2P VPS server. Shared by all clients.
const P2pVpsServer = require("../lib/p2p-vps-server.js");
const p2pVpsServer = new P2pVpsServer(deviceConfig);

// Create an Express server. Future development will allow serving of webpages and creation of Client API.
const ExpressServer = require("../lib/express-server.js");
const expressServer = new ExpressServer(app, port);
expressServer.start();

// This is a high-level function used to register this Client with the Server.
// It calls the registration function, writes out the support files, builds the Docker container,
// and launches the Docker container.
function registerDevice() {
  //Simulate benchmark tests with dummy data.
  const now = new Date();
  const deviceSpecs = {
    memory: "Fake Test Data",
    diskSpace: "Fake Test Data",
    processor: "Fake Test Data",
    internetSpeed: "Fake Test Data",
    checkinTimeStamp: now.toISOString(),
  };

  const config = {
    deviceId: deviceConfig.deviceId,
    deviceSpecs: deviceSpecs,
  };

  const execaOptions = {
    stdout: "inherit",
    stderr: "inherit",
  };

  // Register with the server.
  p2pVpsServer
    .register(config)

    // Write out support files (Dockerfile, config.json)
    .then(clientData => {
      //debugger;

      // Save data to a global variable for use in later functions.
      global.clientData = clientData;

      return (
        // Write out the Dockerfile.
        writeFiles
          .writeDockerfile(clientData.port, clientData.username, clientData.password)

          // Write out the config file.
          .then(() => {
            return writeFiles.writeClientConfig();
          })

          .catch(err => {
            console.error("Problem writing out support files: ", err);
          })
      );
    })

    // Build the Docker container.
    .then(() => {
      return execa("./lib/buildImage", undefined, execaOptions)
        .then(result => {
          //debugger;
          console.log(result.stdout);
        })
        .catch(err => {
          debugger;
          console.error("Error while trying to build Docker image!");
          console.error(JSON.stringify(err, null, 2));
          process.exit(1);
        });
    })

    // Run the Docker container
    .then(() => {
      return execa("./lib/runImage", undefined, execaOptions)
        .then(result => {
          //debugger;
          console.log(result.stdout);
        })
        .catch(err => {
          debugger;
          console.error("Error while trying to run Docker image!");
          console.error(JSON.stringify(err, null, 2));
          process.exit(1);
        });
    })

    .then(() => {
      console.log("Docker image has been built and is running.");

      // Begin 10 minutes loop
      checkExpirationTimer = setInterval(function() {
        checkExpiration();
      }, 2 * 60000);
    })

    .catch(err => {
      console.error("Error in main program: ", err);
      process.exit(1);
    });
}
registerDevice();

// This function is called by a timer after the Docker contain has been successfully
// launched.
function checkExpiration() {
  debugger;

  const now = new Date();
  console.log(`checkExpiration() running at ${now}`);

  // Get the expiration date for this device from the server.
  p2pVpsServer
    .getExpiration(deviceConfig.deviceId)

    // Check expiration date.
    .then(expiration => {
      //const now = new Date();

      console.log(`Expiration date: ${expiration}`);
      console.log(`Expiration type: ${typeof expiration}`);

      const expirationDate = new Date(expiration);

      // If the expiration date has been reached
      if (expirationDate.getTime() < now.getTime()) {
        // Stop the docker container.
        console.log("Stopping the docker container");
        const stream = execa("./lib/stopImage").stdout;

        stream.pipe(process.stdout);

        return (
          getStream(stream)
            // Clean up any orphaned docker images.
            .then(output => {
              const stream2 = execa("./lib/cleanupImages").stdout;

              stream2.pipe(process.stdout);

              return getStream(stream2);
            })

            // Reregister the device.
            .then(output => {
              debugger;
              clearInterval(checkExpirationTimer); // Stop the timer.

              registerDevice(); // Re-register the device with the server.
            })
        );
      }
    })

    .catch(err => {
      debugger;
      console.error("Error in checkExpiration(): ");

      if (err.statusCode >= 500 || err.name === "RequestError") {
        console.error("Connection to the server was refused. Will try again.");
      } else {
        debugger;
        console.error(JSON.stringify(err, null, 2));
      }
    });
}
import { readFile, appendFile } from 'fs/promises';
import os from 'os';

// Store the original console.log and override it
const originalLog = console.log; console.log = mylogger;

const thisAddonName = "stremio-jellyfin-bridge";

const gc = Object.freeze({
    thisAddonName: thisAddonName,
    thisAddonVersion: "1.0.1"
});


function mylogger () {
    var args = [].slice.call(arguments);
    originalLog.apply(console.log,[getCurrentDateString()].concat(args));

    // Returns current timestamp
    function getCurrentDateString() {
        const date = new Date();
        return new Date(date.getTime() - (date.getTimezoneOffset() * 60000)).toISOString().slice(0, -1).replace('T', '_') + " ::";
    };
}

export default gc;

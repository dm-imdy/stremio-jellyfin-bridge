import { loadEnvFile } from 'node:process';
import { join } from 'node:path';

// Construct the absolute path to .env relative to THIS file's location.
// import.meta.dirname is the ESM equivalent of __dirname in modern Node.js.
const envFilePath = join(import.meta.dirname, '.env');

try {
    // Load the variables. This will work natively if the file exists
    process.loadEnvFile(envFilePath);
    console.log(`Loaded .env file from: ${envFilePath}`);
} catch (err) {
    // If the file is missing (like inside Docker), we just catch the error 
    // and let the app rely on the variables Docker Compose already injected!
    console.log("ℹ️ No physical .env file found. Relying on system environment variables.");
}

// Dynamically import the main application
// This ensures variables are in process.env before server.js is evaluated
await import('./server.js');

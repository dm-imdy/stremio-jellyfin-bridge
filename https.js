
import axios from "axios";
import https from "https";
import ip from "ip";

// Export a synchronous helper function to generate the URL instantly
export function getHttpsBaseUrl(port) {
    const localIPPrefix = ip.address().replaceAll('.', '-');
    return `https://${localIPPrefix}.local-ip.medicmobile.org:${port}`;
}

export async function serveHTTPS(app, port) {

    const baseUrl = getHttpsBaseUrl(port);

    const json = (await axios.get("https://local-ip.medicmobile.org/keys"))
        .data;
    const cert = `${json.cert}\n${json.chain}`;
    const httpsServer = https.createServer({ key: json.privkey, cert }, app);
    httpsServer.listen(port);
    console.log(`HTTPS addon is accessible at: ${baseUrl}/manifest.json`);
    return httpsServer;

}

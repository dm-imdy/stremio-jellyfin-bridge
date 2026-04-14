import axios from 'axios';

export async function proxyImageHandler(req, res) {
    const jellyfinUrl = req.query.url;

    if (!jellyfinUrl) {
        return res.status(400).send("Missing image URL parameter");
    }

    try {
        // Fetch the image from Jellyfin as a raw binary stream
        const imageResponse = await axios.get(jellyfinUrl, {
            responseType: 'stream'
        });

        // Pass through the correct Content-Type (e.g., image/jpeg)
        res.set('Content-Type', imageResponse.headers['content-type']);
        
        // Pipe the binary stream directly back to Stremio
        imageResponse.data.pipe(res);

    } catch (error) {
        console.log("❌ Proxy error:", error.message);
        res.status(500).send("Error fetching image from Jellyfin");
    }
}
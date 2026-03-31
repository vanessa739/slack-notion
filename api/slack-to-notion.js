import { Client } from '@notionhq/client';

const notion = new Client({
    auth: process.env.NOTION_API_KEY
});

// Simple in-memory dedup to ignore Slack retries
const processedEvents = new Set();

export default async function handler(req, res) {
    if (req.body.type === 'url_verification') {
        return res.status(200).json({ challenge: req.body.challenge });
    }

    const event = req.body.event;

    if (!event || event.bot_id || event.channel !== process.env.SLACK_CHANNEL_ID) {
        return res.status(200).send('Ignored message');
    }

    // Dedup: Slack retries use the same event.ts + channel combo
    const eventKey = `${event.channel}-${event.ts}`;
    if (processedEvents.has(eventKey)) {
        return res.status(200).send('Duplicate, skipping');
    }
    processedEvents.add(eventKey);

    // Prevent unbounded memory growth (keep last 100)
    if (processedEvents.size > 100) {
        const first = processedEvents.values().next().value;
        processedEvents.delete(first);
    }

    try {
        const messageText = event.text || "No description provided";
        const timestamp = new Date(parseFloat(event.ts) * 1000).toISOString();
        const title = messageText.substring(0, 100) || (event.files?.[0]?.name ?? "Untitled");

        const uploadedFileIds = [];
        if (event.files && event.files.length > 0) {
            for (const file of event.files) {
                try {
                    // Step 1: Download from Slack
                    const slackResponse = await fetch(file.url_private, {
                        headers: { Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}` }
                    });
                    if (!slackResponse.ok) {
                        console.error(`Slack download failed for ${file.name}: ${slackResponse.statusText}`);
                        continue;
                    }
                    const fileBuffer = Buffer.from(await slackResponse.arrayBuffer());

                    // Step 2: Create Notion upload record (JSON body, not octet-stream)
                    const createResponse = await fetch('https://api.notion.com/v1/file_uploads', {
                        method: 'POST',
                        headers: {
                            'Authorization': `Bearer ${process.env.NOTION_API_KEY}`,
                            'Content-Type': 'application/json',
                            'Notion-Version': '2025-09-03',
                        },
                        body: JSON.stringify({ name: file.name, content_type: file.mimetype }),
                    });
                    const uploadRecord = await createResponse.json();

                    if (!uploadRecord.upload_url) {
                        console.error('No upload URL found in Notion response:', uploadRecord);
                        continue;
                    }

                    // Step 3: PUT the actual file bytes
                    const putResponse = await fetch(uploadRecord.upload_url, {
                        method: 'PUT',
                        headers: { 'Content-Type': file.mimetype },
                        body: fileBuffer,
                    });

                    if (!putResponse.ok) {
                        console.error(`Failed to upload file to Notion: ${putResponse.statusText}`);
                        continue;
                    }

                    uploadedFileIds.push(uploadRecord.id);
                } catch (fileError) {
                    console.error(`Error processing file ${file.name}: ${fileError.message}`);
                    continue;
                }
            }
        }

        const urlRegex = /https?:\/\/[^\s>]+/g;
        const extractedUrls = messageText.match(urlRegex) || [];

        const properties = {
            Name: { title: [{ text: { content: title } }] },
            Date: { date: { start: timestamp } },
            Source: { rich_text: [{ text: { content: "FDE Learning Channel" } }] },
        };

        if (extractedUrls.length > 0) {
            properties.Links = {
                rich_text: extractedUrls.map((url, index) => ({
                    text: { content: index > 0 ? `\n${url}` : url, link: { url } },
                })),
            };
        }

        if (uploadedFileIds.length > 0) {
            properties.Files = {
                files: uploadedFileIds.map(id => ({
                    type: "file_upload",
                    file_upload: { id },
                })),
            };
        }

        await notion.pages.create({
            parent: { data_source_id: process.env.NOTION_DATABASE_ID },
            properties,
        });

        console.log(`Successfully sent message to Notion: ${title}`);
        return res.status(200).send('Message sent to Notion');
    } catch (error) {
        console.error('Error sending message to Notion:', error);
        return res.status(200).send('Error but ack');
    }
}
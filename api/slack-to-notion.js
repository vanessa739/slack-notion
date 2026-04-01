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
    console.log('Incoming event:', JSON.stringify({
        type: event?.type,
        subtype: event?.subtype,
        channel: event?.channel,
        bot_id: event?.bot_id,
        user: event?.user,
        ts: event?.ts,
        hasFiles: !!(event?.files?.length),
        text: event?.text?.substring(0, 50),
    }));
    console.log('Slack channel ID:', process.env.SLACK_CHANNEL_ID);


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
            console.log('=== FILE UPLOAD START ===');
            console.log('Number of files:', event.files.length);
            console.log('Files metadata:', JSON.stringify(event.files.map(f => ({
                name: f.name, mimetype: f.mimetype, size: f.size,
                url_private: f.url_private ? 'present' : 'MISSING',
                filetype: f.filetype, mode: f.mode,
            }))));
            for (const file of event.files) {
                console.log(`--- Processing file: ${file.name} (${file.mimetype}, ${file.size} bytes) ---`);
                try {
                    // Step 1: Download from Slack
                    console.log(`[Step 1] Downloading from Slack: ${file.url_private}`);
                    console.log(`[Step 1] SLACK_BOT_TOKEN present: ${!!process.env.SLACK_BOT_TOKEN}, length: ${process.env.SLACK_BOT_TOKEN?.length}`);
                    const slackResponse = await fetch(file.url_private, {
                        headers: { Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}` }
                    });
                    console.log(`[Step 1] Slack response status: ${slackResponse.status} ${slackResponse.statusText}`);
                    console.log(`[Step 1] Slack response headers:`, JSON.stringify(Object.fromEntries(slackResponse.headers.entries())));
                    if (!slackResponse.ok) {
                        console.error(`[Step 1] Slack download FAILED for ${file.name}: ${slackResponse.status} ${slackResponse.statusText}`);
                        const errorBody = await slackResponse.text();
                        console.error(`[Step 1] Slack error body:`, errorBody);
                        continue;
                    }
                    const fileBuffer = Buffer.from(await slackResponse.arrayBuffer());
                    console.log(`[Step 1] Downloaded ${fileBuffer.length} bytes from Slack`);


                    const uploadRecord = await fetch('https://api.notion.com/v1/file_uploads', {
                        method: 'POST',
                        headers: {
                            'Authorization': `Bearer ${process.env.NOTION_API_KEY}`,
                            'Content-Type': 'application/json',
                            'Notion-Version': '2022-06-28',
                        },
                        body: JSON.stringify({
                            mode: "single_part",
                            filename: file.name,
                            content_type: file.mimetype,
                        }),
                    });
                    const uploadResponse = await uploadRecord.json();
                    console.log('Upload record:', JSON.stringify(uploadResponse));
                    
                    if (!uploadResponse.upload_url) {
                        console.error('No upload_url in response:', JSON.stringify(uploadResponse));
                        continue;
                    }
                    
                    // Step 3: Send file bytes as multipart form data
                    const formData = new FormData();
                    formData.append('file', new Blob([fileBuffer], { type: file.mimetype }), file.name);

                    console.log(`[Step 3] Sending ${fileBuffer.length} bytes to upload_url as FormData`);
                    const putResponse = await fetch(uploadResponse.upload_url, {
                        method: 'POST',
                        headers: {
                            'Authorization': `Bearer ${process.env.NOTION_API_KEY}`,
                            'Notion-Version': '2022-06-28',
                        },
                        body: formData,
                    });
                    console.log('PUT status:', putResponse.status, putResponse.statusText);
                    if (!putResponse.ok) {
                        console.error('PUT failed:', await putResponse.text());
                        continue;
                    }
                    
                    uploadedFileIds.push(uploadResponse.id);
                    console.log(`File ${file.name} completed, id: ${uploadResponse.id}`);
                } catch (fileError) {   
                    console.error(`Error processing file ${file.name}:`, fileError.message, fileError.stack);
                    continue;
                }
            }
            console.log('=== FILE UPLOAD END === uploadedFileIds:', JSON.stringify(uploadedFileIds));
        } else {
            console.log('No files attached to this event. event.files:', JSON.stringify(event.files));
        }

        const urlRegex = /https?:\/\/[^\s>]+/g;
        const extractedUrls = messageText.match(urlRegex) || [];
        console.log('Extracted URLs from message:', JSON.stringify(extractedUrls));
        console.log('uploadedFileIds going into properties:', JSON.stringify(uploadedFileIds));

        const properties = {
            Name: { title: [{ text: { content: title } }] },
            Created: { date: { start: timestamp } },
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

        console.log('Creating Notion page with properties:', JSON.stringify(properties, null, 2));
        await notion.pages.create({
            parent: { data_source_id: process.env.NOTION_DATABASE_ID },
            properties,
        });

        console.log(`Successfully sent message to Notion: ${title}`);
        return res.status(200).send('Message sent to Notion');
    } catch (error) {
        console.error('Error sending message to Notion:', error.message, error.body ?? '', error.stack);
        return res.status(200).send('Error but ack');
    }
}
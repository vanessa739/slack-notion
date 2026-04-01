import { Client } from '@notionhq/client';

const notion = new Client({
    auth: process.env.NOTION_API_KEY
});

const processedEvents = new Set();

// Fetch the parent message text from a thread
async function getParentMessage(channel, threadTs) {
    const response = await fetch(`https://slack.com/api/conversations.replies?channel=${channel}&ts=${threadTs}&limit=1`, {
        headers: { Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}` }
    });
    const data = await response.json();
    if (!data.ok) {
        console.error('Failed to fetch parent message:', data.error);
        return null;
    }
    return data.messages?.[0]; // First message in a thread is always the parent
}

// Check how many replies a thread has
async function getThreadReplyCount(channel, threadTs) {
    const response = await fetch(`https://slack.com/api/conversations.replies?channel=${channel}&ts=${threadTs}`, {
        headers: { Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}` }
    });
    const data = await response.json();
    if (!data.ok) {
        console.error('Failed to fetch thread replies:', data.error);
        return -1;
    }
    // First message is the parent, rest are replies
    return (data.messages?.length || 1) - 1;
}

async function uploadFilesToNotion(files) {
    const uploadedFileIds = [];
    if (!files || files.length === 0) return uploadedFileIds;

    console.log('=== FILE UPLOAD START ===');
    console.log('Number of files:', files.length);

    for (const file of files) {
        console.log(`--- Processing file: ${file.name} (${file.mimetype}, ${file.size} bytes) ---`);
        try {
            // Step 1: Download from Slack
            const slackResponse = await fetch(file.url_private, {
                headers: { Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}` }
            });
            if (!slackResponse.ok) {
                console.error(`Slack download FAILED for ${file.name}: ${slackResponse.status}`);
                continue;
            }
            const fileBuffer = Buffer.from(await slackResponse.arrayBuffer());
            console.log(`Downloaded ${fileBuffer.length} bytes from Slack`);

            // Step 2: Create Notion upload record
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

            // Step 3: Send file bytes
            const formData = new FormData();
            formData.append('file', new Blob([fileBuffer], { type: file.mimetype }), file.name);

            const putResponse = await fetch(uploadResponse.upload_url, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${process.env.NOTION_API_KEY}`,
                    'Notion-Version': '2022-06-28',
                },
                body: formData,
            });
            console.log('Upload status:', putResponse.status, putResponse.statusText);
            if (!putResponse.ok) {
                console.error('Upload failed:', await putResponse.text());
                continue;
            }

            uploadedFileIds.push(uploadResponse.id);
            console.log(`File ${file.name} completed, id: ${uploadResponse.id}`);
        } catch (fileError) {
            console.error(`Error processing file ${file.name}:`, fileError.message);
            continue;
        }
    }
    console.log('=== FILE UPLOAD END === uploadedFileIds:', JSON.stringify(uploadedFileIds));
    return uploadedFileIds;
}

export default async function handler(req, res) {
    if (req.body.type === 'url_verification') {
        return res.status(200).json({ challenge: req.body.challenge });
    }

    const event = req.body.event;
    console.log('Incoming event:', JSON.stringify({
        type: event?.type,
        subtype: event?.subtype,
        channel: event?.channel,
        user: event?.user,
        ts: event?.ts,
        thread_ts: event?.thread_ts,
        hasFiles: !!(event?.files?.length),
        text: event?.text?.substring(0, 50),
    }));

    // Ignore bots, wrong channel
    if (!event || event.bot_id || event.channel !== process.env.SLACK_CHANNEL_ID) {
        return res.status(200).send('Ignored');
    }

    // Ignore main messages (no thread_ts, or thread_ts === ts)
    if (!event.thread_ts || event.thread_ts === event.ts) {
        console.log('Main message, skipping — waiting for first reply');
        return res.status(200).send('Main message, skipping');
    }

    // It's a thread reply — check if it's the first one
    const replyCount = await getThreadReplyCount(event.channel, event.thread_ts);
    console.log(`Thread ${event.thread_ts} has ${replyCount} replies`);

    if (replyCount > 1) {
        console.log('Not the first reply, skipping');
        return res.status(200).send('Not first reply, skipping');
    }

    // Dedup
    const eventKey = `${event.channel}-${event.ts}`;
    if (processedEvents.has(eventKey)) {
        return res.status(200).send('Duplicate, skipping');
    }
    processedEvents.add(eventKey);
    if (processedEvents.size > 100) {
        const first = processedEvents.values().next().value;
        processedEvents.delete(first);
    }

    try {
        // Fetch parent message for the title
        const parentMessage = await getParentMessage(event.channel, event.thread_ts);
        const title = (parentMessage?.text || "Untitled").substring(0, 100);
        const description = event.text || "No description provided";
        const timestamp = new Date(parseFloat(event.thread_ts) * 1000).toISOString();

        // Collect files from both parent and first reply
        const allFiles = [
            ...(parentMessage?.files || []),
            ...(event.files || []),
        ];
        const uploadedFileIds = await uploadFilesToNotion(allFiles);

        // Collect URLs from both messages
        const urlRegex = /https?:\/\/[^\s>]+/g;
        const allUrls = [
            ...(parentMessage?.text?.match(urlRegex) || []),
            ...(description.match(urlRegex) || []),
        ];

        const properties = {
            Name: { title: [{ text: { content: title } }] },
            Created: { date: { start: timestamp } },
            Source: { rich_text: [{ text: { content: "FDE Learning Channel" } }] },
            Description: { rich_text: [{ text: { content: description.substring(0, 2000) } }] },
        };

        if (allUrls.length > 0) {
            properties.Links = {
                rich_text: allUrls.map((url, index) => ({
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

        console.log(`Successfully created Notion page: ${title}`);
        return res.status(200).send('Created Notion page');
    } catch (error) {
        console.error('Error:', error.message, error.body ?? '', error.stack);
        return res.status(200).send('Error but ack');
    }
}
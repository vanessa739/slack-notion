import { Client } from '@notionhq/client';

const notion = new Client({
    auth: process.env.NOTION_API_KEY
});

const processedEvents = new Set();

async function getThreadMessages(channel, threadTs) {
    const response = await fetch(`https://slack.com/api/conversations.replies?channel=${channel}&ts=${threadTs}`, {
        headers: { Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}` }
    });
    const data = await response.json();
    if (!data.ok) {
        console.error('Failed to fetch thread:', data.error);
        return [];
    }
    return data.messages || [];
}

async function findNotionPageByThreadId(threadTs) {
    try {
        console.log('Querying for ThreadID:', threadTs);
        const response = await fetch(`https://api.notion.com/v1/data_sources/${process.env.NOTION_DATABASE_ID}/query`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${process.env.NOTION_API_KEY}`,
                'Content-Type': 'application/json',
                'Notion-Version': '2026-03-11',
            },
            body: JSON.stringify({
                filter: {
                    property: 'ThreadID',
                    rich_text: { equals: threadTs },
                },
            }),
        });
        console.log('Query response status:', response.status);
        const text = await response.text();
        console.log('Query response body:', text);
        const data = JSON.parse(text);
        return data.results?.[0] || null;
    } catch (err) {
        console.error('findNotionPageByThreadId error:', err.message, err.stack);
        return null;
    }
}

async function uploadFilesToNotion(files) {
    const uploadedFileIds = [];
    if (!files || files.length === 0) return uploadedFileIds;

    console.log('=== FILE UPLOAD START ===');
    for (const file of files) {
        console.log(`--- Processing: ${file.name} (${file.mimetype}, ${file.size} bytes) ---`);
        try {
            // Step 1: Download from Slack
            const slackResponse = await fetch(file.url_private, {
                headers: { Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}` }
            });
            if (!slackResponse.ok) {
                console.error(`Slack download FAILED: ${slackResponse.status}`);
                continue;
            }
            const fileBuffer = Buffer.from(await slackResponse.arrayBuffer());
            console.log(`Downloaded ${fileBuffer.length} bytes`);

            // Step 2: Create Notion upload record
            const uploadRecord = await fetch('https://api.notion.com/v1/file_uploads', {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${process.env.NOTION_API_KEY}`,
                    'Content-Type': 'application/json',
                    'Notion-Version': '2026-03-11',
                },
                body: JSON.stringify({
                    mode: "single_part",
                    filename: file.name,
                    content_type: file.mimetype,
                }),
            });
            const uploadResponse = await uploadRecord.json();

            if (!uploadResponse.upload_url) {
                console.error('No upload_url:', JSON.stringify(uploadResponse));
                continue;
            }

            // Step 3: Send file bytes
            const formData = new FormData();
            formData.append('file', new Blob([fileBuffer], { type: file.mimetype }), file.name);

            const putResponse = await fetch(uploadResponse.upload_url, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${process.env.NOTION_API_KEY}`,
                    'Notion-Version': '2026-03-11',
                },
                body: formData,
            });
            if (!putResponse.ok) {
                console.error('Upload failed:', await putResponse.text());
                continue;
            }

            uploadedFileIds.push(uploadResponse.id);
            console.log(`File ${file.name} uploaded, id: ${uploadResponse.id}`);
        } catch (err) {
            console.error(`Error processing ${file.name}:`, err.message);
            continue;
        }
    }
    console.log('=== FILE UPLOAD END === ids:', JSON.stringify(uploadedFileIds));
    return uploadedFileIds;
}

async function getSlackUserName(userId) {
    const response = await fetch(`https://slack.com/api/users.info?user=${userId}`, {
        headers: { Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}` }
    });
    const data = await response.json();
    if (!data.ok) {
        console.error('Failed to fetch user:', data.error);
        return userId; // fallback to raw ID
    }
    return data.user?.real_name || data.user?.name || userId;
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

    if (!event || event.channel !== process.env.SLACK_CHANNEL_ID) {
        return res.status(200).send('Ignored');
    }

    // Ignore main messages — wait for replies
    if (!event.thread_ts || event.thread_ts === event.ts) {
        console.log('Main message, skipping');
        return res.status(200).send('Main message, skipping');
    }

    // Skip bot subscription notifications (causes duplicate pages)
    if (/^subscribed\s+<@[A-Z0-9]+>\s+to the thread$/i.test((event.text || '').trim())) {
        console.log('Bot subscription message, skipping');
        return res.status(200).send('Subscription message, skipping');
    }

    // Skip thread-closed notifications
    if (/:\s*white_check_mark\s*:\s*Closed by/i.test(event.text || '')) {
        console.log('Thread-closed message, skipping');
        return res.status(200).send('Thread closed, skipping');
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
        const threadTs = event.thread_ts;
        const existingPage = await findNotionPageByThreadId(threadTs);

        if (existingPage) {
            // --- UPDATE PATH: Page exists, append new files ---
            console.log(`Found existing Notion page for thread ${threadTs}: ${existingPage.id}`);

            if (event.files && event.files.length > 0) {
                const newFileIds = await uploadFilesToNotion(event.files);

                if (newFileIds.length > 0) {
                    // Get existing file IDs from the page
                    const existingFiles = existingPage.properties.Files?.files || [];
                    const allFileEntries = [
                        ...existingFiles,
                        ...newFileIds.map(id => ({
                            type: "file_upload",
                            file_upload: { id },
                        })),
                    ];

                    await notion.pages.update({
                        page_id: existingPage.id,
                        properties: {
                            Files: { files: allFileEntries },
                        },
                    });
                    console.log(`Updated Notion page with ${newFileIds.length} new files`);
                }
            } else {
                console.log('No files in this reply, nothing to update');
            }

            return res.status(200).send('Updated existing page');
        }

        // --- CREATE PATH: First reply, create new page ---
        const threadMessages = await getThreadMessages(event.channel, threadTs);
        console.log('Thread messages count:', threadMessages.length);

        const parentMessage = threadMessages[0];
        const title = (parentMessage?.text || "Untitled").substring(0, 100);
        const timestamp = new Date(parseFloat(threadTs) * 1000).toISOString();
        const author = await getSlackUserName(event?.user);
        console.log('Parent message full: ', JSON.stringify(parentMessage, null, 2));

        let description = event.text || "No description provided";
        if (description.startsWith(title)) {
            description = description.slice(title.length).replace(/^[\s\-:]+/, '').trim();
        }
        if (!description) description = "No description provided";

        // Upload all files from entire thread
        const allFiles = [];
        for (const msg of threadMessages) {
            if (msg.files) allFiles.push(...msg.files);
        }
        const uploadedFileIds = await uploadFilesToNotion(allFiles);

        // Collect URLs from parent + first reply
        const urlRegex = /https?:\/\/[^\s>]+/g;
        const allUrls = [
            ...(parentMessage?.text?.match(urlRegex) || []),
            ...(description.match(urlRegex) || []),
        ];

        const properties = {
            Name: { title: [{ text: { content: title } }] },
            Author: { rich_text: [{ text: { content: author } }] },
            Created: { date: { start: timestamp } },
            Source: { rich_text: [{ text: { content: "FDE Learning Channel" } }] },
            Description: { rich_text: [{ text: { content: description.substring(0, 2000) } }] },
            ThreadID: { rich_text: [{ text: { content: threadTs } }] },
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

        console.log('Creating Notion page:', JSON.stringify(properties, null, 2));
        await notion.pages.create({
            parent: { data_source_id: process.env.NOTION_DATABASE_ID },
            properties,
        });

        console.log(`Created Notion page: ${title}`);
        return res.status(200).send('Created Notion page');
    } catch (error) {
        console.error('Error:', error.message, error.body ?? '', error.stack);
        return res.status(200).send('Error but ack');
    }
}
import { Client } from '@notionhq/client';

const notion = new Client({
    auth: process.env.NOTION_API_KEY
});

export default async function handler(req, res) {
    if (req.body.type === 'url_verification') {
        return res.status(200).json({ challenge: req.body.challenge });
    }

    res.status(200).send('Hello, world!');

    if (!event || event.bot_id || event.channel !== process.env.SLACK_CHANNEL_ID) {
        return;
    }

    try {
        const messageText = event.text || "No description provided";
        const timestamp = new Date(event.ts * 1000).toISOString();

        let resourceUrls = [];
        if (event.files && event.files.length > 0) {
            resourceUrls = event.files.map(file => file.permalink);
        } else {
            const urlRegex = /https?:\/\/[^\s]+/;
            const urls = messageText.match(urlRegex);
            if (urls && urls.length > 0) {
                resourceUrls = urls;
            }
        }

        await notion.pages.create({
            parent: { data_source_id: process.env.NOTION_DATABASE_ID},
            properties: {
                Name: { title: [{ text: { content: messageText.substring(0, 100)}}]},
                Date: { date: { start: timestamp }},
                Links: { rich_text: resourceUrls.map(url => ({ text: { content: url }}))},
                Source: { rich_text: [{ text: { content: "FDE Learning Channel"}}]},
            }
        })

        return res.status(200).send('Message sent to Notion');
    } catch (error) {
        console.error('Error sending message to Notion:', error);
        return res.status(500).send('Error sending message to Notion');
    }
}

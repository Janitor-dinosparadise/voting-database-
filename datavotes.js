console.log("Starting bot script...");
import { Client, GatewayIntentBits, SlashCommandBuilder } from 'discord.js';
import fetch from 'node-fetch'; // For API requests
import mysql from 'mysql2/promise'; // MySQL integration
import dotenv from 'dotenv';

dotenv.config();

// Create a MySQL connection pool
const db = mysql.createPool({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    port: process.env.DB_PORT,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0,
    connectTimeout: 20000, // Increased timeout for database connection
});

// Function to initialize the votes table if it doesn't exist with retry logic
async function initializeDatabase() {
    const createTableQuery = `
        CREATE TABLE IF NOT EXISTS votes (
            id INT AUTO_INCREMENT PRIMARY KEY,
            nickname VARCHAR(255) NOT NULL UNIQUE,
            votes INT NOT NULL DEFAULT 0,
            timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    `;
    
    let retries = 0;
    const maxRetries = 5;
    
    while (retries < maxRetries) {
        try {
            await db.query(createTableQuery);
            console.log('Votes table initialized');
            return;
        } catch (error) {
            retries++;
            console.error(`Error initializing database (Attempt ${retries}): ${error.message}`);
            console.error(`Stack trace: ${error.stack}`);
            if (retries >= maxRetries) {
                console.error('Max retries reached. Could not initialize database.');
            } else {
                console.log('Retrying...');
                await new Promise(res => setTimeout(res, 5000));  // Retry after 5 seconds
            }
        }
    }
}

// Fetch votes from the database
async function getStoredVotes() {
    try {
        const [rows] = await db.query('SELECT nickname, votes FROM votes');
        console.log('Stored votes retrieved:', rows);
        return rows;
    } catch (error) {
        console.error('Error fetching stored votes:', error.message);
        return [];
    }
}

// Save new votes to the database
async function saveVotesToDatabase(newVotes) {
    const insertQuery = `
        INSERT INTO votes (nickname, votes) VALUES (?, ?)
        ON DUPLICATE KEY UPDATE votes = votes + VALUES(votes)
    `;
    try {
        const promises = newVotes.map(vote =>
            db.execute(insertQuery, [vote.nickname, vote.votes])
        );
        await Promise.all(promises);
        console.log('New votes saved to the database');
    } catch (error) {
        console.error('Error saving votes to database:', error.message);
    }
}

// Fetch new votes from API and update the database
async function fetchVotesFromApi(apiUrl) {
    console.log(`Fetching votes from API: ${apiUrl}`);
    try {
        const response = await fetch(apiUrl);
        if (!response.ok) {
            console.error(`Error fetching votes from ${apiUrl}: ${response.statusText}`);
            return [];
        }

        const data = await response.json();
        console.log('API response received:', data);

        if (Array.isArray(data.voters)) {
            const storedVotes = await getStoredVotes();
            const storedNicknames = storedVotes.map(vote => vote.nickname);

            const newVotes = data.voters.filter(
                vote => !storedNicknames.includes(vote.nickname)
            );

            if (newVotes.length > 0) {
                console.log('New votes to save:', newVotes);
                await saveVotesToDatabase(newVotes);
            } else {
                console.log('No new votes to save');
            }

            return newVotes;
        } else {
            console.error('Invalid response format from API');
            return [];
        }
    } catch (error) {
        console.error(`Error fetching votes from ${apiUrl}: ${error.message}`);
        return [];
    }
}

// Polling multiple APIs
async function pollVotes(apiUrls) {
    const newVotes = [];
    for (const apiUrl of apiUrls) {
        try {
            console.log(`Polling API: ${apiUrl}`);
            const votesFromApi = await fetchVotesFromApi(apiUrl);
            newVotes.push(...votesFromApi);
        } catch (error) {
            console.error(`Failed to fetch from API: ${apiUrl}`, error.message);
        }
    }
    console.log('Total new votes:', newVotes);
    return newVotes;
}

// Discord bot setup
const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages],
});

const apiUrls = process.env.API_URLS.split(',');

// Create the /votes command using SlashCommandBuilder
const votesCommand = new SlashCommandBuilder()
    .setName('voting')
    .setDescription('Retrieve the current votes');

// Register the /votes slash command on bot startup
client.once('ready', async () => {
    console.log(`Logged in as ${client.user.tag}`);
    console.log('API URLs:', apiUrls);

    // Initialize the database
    await initializeDatabase();

    // Get the specific guild by Guild ID
    const guild = client.guilds.cache.get(process.env.GUILD_ID);
    if (!guild) {
        console.error('Guild not found! Make sure your GUILD_ID is correct in the .env file.');
        return;
    }

    // Register slash command for the specific guild
    try {
        console.log(`Registering command for guild: ${guild.name}`);
        await guild.commands.create(votesCommand);
        console.log('Votes command registered for guild:', guild.name);
    } catch (err) {
        console.error('Error registering command:', err.message);
    }
});

// Handle command interaction
client.on('interactionCreate', async (interaction) => {
    console.log('Interaction received:', interaction.commandName);

    if (!interaction.isCommand()) {
        console.log('Not a command interaction. Ignored.');
        return;
    }

    if (interaction.commandName === 'voting') {
        console.log('Processing /voting command...');
        
        // Acknowledge the interaction immediately to avoid timeout
        await interaction.deferReply();

        const newVotes = await pollVotes(apiUrls);

        // Send the final vote message after polling
        if (newVotes.length > 0) {
            const voteMessage = newVotes
                .map(vote => `User: ${vote.nickname} | Votes: ${vote.votes}`)
                .join('\n');
            await interaction.editReply({
                content: `Here are the latest votes:\n${voteMessage}`,
            });
            console.log('Votes sent in response:', voteMessage);
        } else {
            await interaction.editReply({
                content: 'No new votes found.',
            });
            console.log('No new votes to display.');
        }
    }
});

// Log in the Discord bot
client.login(process.env.TOKEN);

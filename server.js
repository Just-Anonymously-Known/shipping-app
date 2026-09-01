const express = require('express');
const { Pool } = require('pg');
const path = require('path');
const nodemailer = require('nodemailer');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname)));

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

const initDb = async () => {
    try {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS users (
                id SERIAL PRIMARY KEY,
                name VARCHAR(255) NOT NULL,
                email VARCHAR(255) UNIQUE NOT NULL,
                password VARCHAR(255) NOT NULL,
                is_admin BOOLEAN DEFAULT FALSE,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
            ALTER TABLE users ADD COLUMN IF NOT EXISTS phone VARCHAR(50);
            ALTER TABLE users ADD COLUMN IF NOT EXISTS dob VARCHAR(50);

            CREATE TABLE IF NOT EXISTS shipments (
                id SERIAL PRIMARY KEY,
                tracking_number VARCHAR(50) UNIQUE NOT NULL,
                sender_name VARCHAR(255) NOT NULL,
                recipient_name VARCHAR(255) NOT NULL,
                recipient_email VARCHAR(255) NOT NULL,
                recipient_phone VARCHAR(255) NOT NULL,
                destination TEXT NOT NULL,
                payment_method VARCHAR(100) NOT NULL,
                amount DECIMAL(10,2) NOT NULL,
                status VARCHAR(100) DEFAULT 'Processing at Origin Hub',
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
            CREATE TABLE IF NOT EXISTS shipment_events (
                id SERIAL PRIMARY KEY,
                tracking_number VARCHAR(50) NOT NULL,
                status_description TEXT NOT NULL,
                location VARCHAR(255) NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
            CREATE TABLE IF NOT EXISTS admin_settings (
                key VARCHAR(100) PRIMARY KEY,
                value TEXT
            );
        `);
        console.log('Database tables and columns verified/initialized.');
    } catch (err) {
        console.error('Error initializing tables:', err);
    }
};
initDb();

const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS
    }
});

app.post('/api/signup', async (req, res) => {
    const { name, email, password, phone, dob } = req.body;
    try {
        const userCheck = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
        if (userCheck.rows.length > 0) {
            return res.status(400).json({ message: 'Email already registered.' });
        }
        const newUser = await pool.query(
            'INSERT INTO users (name, email, password, phone, dob) VALUES ($1, $2, $3, $4, $5) RETURNING id, name, email, phone, dob, is_admin',
            [name, email, password, phone, dob]
        );
        res.status(201).json(newUser.rows[0]);
    } catch (err) {
        console.error(err);
        res.status(500).json({ message: 'Server error during registration.' });
    }
});

app.post('/api/signin', async (req, res) => {
    const { email, password } = req.body;
    try {
        const user = await pool.query('SELECT * FROM users WHERE email = $1 AND password = $2', [email, password]);
        if (user.rows.length === 0) {
            return res.status(400).json({ message: 'Invalid email or password.' });
        }
        res.json(user.rows[0]);
    } catch (err) {
        console.error(err);
        res.status(500).json({ message: 'Server error during signin.' });
    }
});

app.post('/api/shipments', async (req, res) => {
    const { senderName, recipientName, recipientEmail, recipientPhone, destination, paymentMethod, amount } = req.body;
    const trackingNumber = 'GT-' + Math.floor(100000 + Math.random() * 900000);
    try {
        await pool.query(
            'INSERT INTO shipments (tracking_number, sender_name, recipient_name, recipient_email, recipient_phone, destination, payment_method, amount) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)',
            [trackingNumber, senderName, recipientName, recipientEmail, recipientPhone, destination, paymentMethod, amount]
        );
        await pool.query(
            'INSERT INTO shipment_events (tracking_number, status_description, location) VALUES ($1, $2, $3)',
            [trackingNumber, 'Shipment booked and verified', 'US Origin Sorting Facility']
        );
        
        if (process.env.EMAIL_USER && process.env.EMAIL_PASS) {
            transporter.sendMail({
                from: process.env.EMAIL_USER,
                to: recipientEmail,
                subject: `GlobalTransit Shipment Booked - ${trackingNumber}`,
                text: `Hello ${recipientName},\n\nYour shipment to ${destination} has been successfully booked.\nTracking Number: ${trackingNumber}\n\nTrack your package live on our platform!`
            }).catch(mailErr => console.log('Mail send error:', mailErr));
        }

        res.status(201).json({ success: true, trackingNumber });
    } catch (err) {
        console.error(err);
        res.status(500).json({ message: 'Error creating shipment.' });
    }
});

app.get('/api/shipments/user/:name', async (req, res) => {
    try {
        const shipments = await pool.query('SELECT * FROM shipments WHERE sender_name = $1 ORDER BY id DESC', [req.params.name]);
        res.json(shipments.rows);
    } catch (err) {
        res.status(500).json({ message: 'Error loading user shipments.' });
    }
});

app.get('/api/shipments/:trackingNum', async (req, res) => {
    try {
        const shipment = await pool.query('SELECT * FROM shipments WHERE tracking_number = $1', [req.params.trackingNum]);
        if (shipment.rows.length === 0) {
            return res.status(404).json({ message: 'Shipment not found.' });
        }
        res.json(shipment.rows[0]);
    } catch (err) {
        res.status(500).json({ message: 'Error tracking package.' });
    }
});

app.get('/api/shipments/:trackingNum/events', async (req, res) => {
    try {
        const events = await pool.query('SELECT * FROM shipment_events WHERE tracking_number = $1 ORDER BY id ASC', [req.params.trackingNum]);
        res.json(events.rows);
    } catch (err) {
        res.status(500).json({ message: 'Error loading events.' });
    }
});

app.get('/api/admin/payment-settings', async (req, res) => {
    try {
        const settings = await pool.query('SELECT * FROM admin_settings');
        const settingsObj = {};
        settings.rows.forEach(row => settingsObj[row.key] = row.value);
        res.json(settingsObj);
    } catch (err) {
        res.json({});
    }
});

app.post('/api/admin/payment-settings', async (req, res) => {
    const { bitcoin, zelle, cashapp, venmo, paypal, bankwire } = req.body;
    try {
        const entries = Object.entries({ bitcoin, zelle, cashapp, venmo, paypal, bankwire });
        for (let [key, value] of entries) {
            await pool.query(
                'INSERT INTO admin_settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = $2',
                [key, value]
            );
        }
        res.json({ success: true, message: 'Payment settings updated.' });
    } catch (err) {
        res.status(500).json({ message: 'Error saving settings.' });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`GlobalTransit server running on port ${PORT}`);
});
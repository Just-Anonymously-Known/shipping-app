const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');
const nodemailer = require('nodemailer');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('.'));

app.get('/', (req, res) => {
    res.sendFile(__dirname + '/index.html');
});

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS
    }
});

// User Registration Route
app.post('/api/register', async (req, res) => {
    const { name, email, phone, password } = req.body;
    try {
        const existing = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
        if (existing.rows.length > 0) {
            return res.status(400).json({ message: 'Email already exists' });
        }
        await pool.query(
            'INSERT INTO users (name, email, phone, password_hash) VALUES ($1, $2, $3, $4)',
            [name, email, phone, password]
        );
        res.status(201).json({ message: 'Account created successfully' });
    } catch (err) {
        console.error('Registration error:', err);
        res.status(500).json({ message: 'Server error during registration' });
    }
});

// Login Route
app.post('/api/login', async (req, res) => {
    const { email, password } = req.body;

    if (email === 'Admin' && password === 'Admin@55') {
        return res.json({ 
            message: 'Login successful', 
            name: 'System Administrator', 
            email: 'admin@globaltransit.com', 
            isAdmin: true 
        });
    }

    try {
        const result = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
        if (result.rows.length === 0) {
            return res.status(400).json({ message: 'Invalid email or password' });
        }
        const user = result.rows[0];
        if (password !== user.password_hash) {
            return res.status(400).json({ message: 'Invalid email or password' });
        }
        res.json({ message: 'Login successful', name: user.name, email: user.email, phone: user.phone, isAdmin: false });
    } catch (err) {
        console.error('Login error:', err);
        res.status(500).json({ message: 'Server error during login' });
    }
});

// Create Shipment with Payment Method selection
app.post('/api/shipments', async (req, res) => {
    const { senderName, recipientName, recipientEmail, recipientPhone, destination, paymentMethod, amount } = req.body;
    
    const trackingNumber = 'GT-' + Math.floor(100000 + Math.random() * 900000);
    const status = 'Awaiting Payment / Order Placed';

    try {
        await pool.query(
            'INSERT INTO shipments (tracking_number, sender_name, recipient_name, recipient_phone, destination, status) VALUES ($1, $2, $3, $4, $5, $6)',
            [trackingNumber, senderName, recipientName, recipientPhone, destination, status]
        );

        await pool.query(
            'INSERT INTO shipment_events (tracking_number, location, status_description) VALUES ($1, $2, $3)',
            [trackingNumber, 'US Origin Sorting Hub (New York)', `Order Booked via ${paymentMethod || 'Card'} ($${amount || '0.00'})`]
        );

        if (recipientEmail) {
            const mailOptions = {
                from: process.env.EMAIL_USER,
                to: recipientEmail,
                subject: `Your GlobalTransit Shipment & Invoice! (${trackingNumber})`,
                text: `Hello ${recipientName},\n\nYour shipment has been booked with GlobalTransit.\n\nTracking Number: ${trackingNumber}\nDestination: ${destination}\nPayment Method Selected: ${paymentMethod}\nAmount Due: $${amount || '150.00'}\n\nPlease complete your payment to dispatch your package!`
            };
            transporter.sendMail(mailOptions, (error) => {
                if (error) console.error('Email error:', error);
            });
        }

        res.status(201).json({ message: 'Shipment created successfully', trackingNumber });
    } catch (err) {
        console.error('Shipment creation error:', err);
        res.status(500).json({ message: 'Server error while creating shipment' });
    }
});

// Get User Shipment History
app.get('/api/shipments/user/:senderName', async (req, res) => {
    const { senderName } = req.params;
    try {
        const result = await pool.query(
            'SELECT * FROM shipments WHERE sender_name = $1 ORDER BY created_at DESC',
            [senderName]
        );
        res.json(result.rows);
    } catch (err) {
        console.error('Fetch user shipments error:', err);
        res.status(500).json({ message: 'Server error while fetching user shipments' });
    }
});

// Track Shipment
app.get('/api/shipments/:trackingNumber', async (req, res) => {
    const { trackingNumber } = req.params;
    try {
        const result = await pool.query('SELECT * FROM shipments WHERE tracking_number = $1', [trackingNumber]);
        if (result.rows.length === 0) {
            return res.status(404).json({ message: 'Shipment not found' });
        }
        res.json(result.rows[0]);
    } catch (err) {
        console.error('Tracking error:', err);
        res.status(500).json({ message: 'Server error while tracking' });
    }
});

// Add Checkpoint Event
app.post('/api/shipments/:trackingNumber/events', async (req, res) => {
    const { trackingNumber } = req.params;
    const { location, statusDescription } = req.body;

    try {
        await pool.query(
            'INSERT INTO shipment_events (tracking_number, location, status_description) VALUES ($1, $2, $3)',
            [trackingNumber, location, statusDescription]
        );
        await pool.query(
            'UPDATE shipments SET status = $1 WHERE tracking_number = $2',
            [statusDescription, trackingNumber]
        );
        res.status(201).json({ message: 'Checkpoint added successfully' });
    } catch (err) {
        console.error('Event creation error:', err);
        res.status(500).json({ message: 'Server error while adding checkpoint' });
    }
});

app.get('/api/shipments/:trackingNumber/events', async (req, res) => {
    const { trackingNumber } = req.params;
    try {
        const result = await pool.query(
            'SELECT * FROM shipment_events WHERE tracking_number = $1 ORDER BY created_at DESC',
            [trackingNumber]
        );
        res.json(result.rows);
    } catch (err) {
        console.error('Fetch events error:', err);
        res.status(500).json({ message: 'Server error while fetching history' });
    }
});

// --- ADMIN PAYMENT SETTINGS ENDPOINTS ---
app.get('/api/admin/payment-settings', async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM payment_settings LIMIT 1');
        if (result.rows.length === 0) {
            return res.json({ bitcoin: 'bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh', zelle: 'payments@globaltransit.com', cashapp: '$GlobalTransitUS', venmo: '@GlobalTransit', paypal: 'pay@globaltransit.com', bankwire: 'Chase Bank #9988223311' });
        }
        res.json(result.rows[0]);
    } catch (err) {
        res.status(500).json({ message: 'Error fetching payment settings' });
    }
});

app.post('/api/admin/payment-settings', async (req, res) => {
    const { bitcoin, zelle, cashapp, venmo, paypal, bankwire } = req.body;
    try {
        await pool.query('DELETE FROM payment_settings');
        await pool.query(
            'INSERT INTO payment_settings (bitcoin, zelle, cashapp, venmo, paypal, bankwire) VALUES ($1, $2, $3, $4, $5, $6)',
            [bitcoin, zelle, cashapp, venmo, paypal, bankwire]
        );
        res.json({ message: 'Payment settings updated successfully' });
    } catch (err) {
        console.error(err);
        res.status(500).json({ message: 'Error updating payment settings' });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server is running on http://localhost:${PORT}`));
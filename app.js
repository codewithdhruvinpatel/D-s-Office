const express = require('express');
const session = require('express-session');
const { Pool } = require('pg');
const pgSession = require('connect-pg-simple')(session);
const bodyParser = require('body-parser');
const path = require('path');
const multer = require('multer');
const storageP = multer.memoryStorage();  // store file directly in memory
const uploadP = multer({ storage: storageP });
const fetch = require('node-fetch'); // for calling YouTube API
const axios = require('axios');
const PDFDocument = require('pdfkit');
const app = express();

// ======================
// Database Setup (PostgreSQL)
// ======================
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  }
});

pool.connect()
  .then(() => console.log('✅ Connected to PostgreSQL'))
  .catch((err) => console.error('❌ PostgreSQL Connection Error:', err));

// ======================
// Middleware Setup
// ======================
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.static('public'));

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// ======================
// Session Setup
// ======================


app.use(session({
  secret: "MySuperSecretKey123!@#", // your hardcoded secret
  resave: false,
  saveUninitialized: true,
  cookie: {
    maxAge: 1000 * 60 * 60 * 24 // 1 day
  }
}));

function checkAuth(req, res, next) {
  if (!req.session.user) return res.redirect('/');
  else if (req.session.user.role !== 'admin') {
    return res.status(403).send('⚠️ Access denied');
  }
  next();
}
// ======================
// apps
// ======================

// Home Page
app.get('/', (req, res) => {
  res.render('login', { user: req.session.user });
});


// Configure multer for video uploads
const storage = multer.diskStorage({
  destination: './uploads/videos/',
  filename: (req, file, cb) => {
    cb(null, Date.now() + path.extname(file.originalname));
  }
});
const upload = multer({ storage });


// Handle Login
app.post('/login', async (req, res) => {
  const { email, password } = req.body;

  const admin = { email: 'admin', password: 'admin' };

  try {
    // Check if admin
    if (email === admin.email && password === admin.password) {
      req.session.user = { id: 0, name: 'Admin', role: 'admin' };
      return res.redirect('/admin'); // Redirect to attendance unlock page
    }

    // Check regular user
    const result = await pool.query(
      'SELECT * FROM users WHERE email = $1 AND password = $2',
      [email, password]
    );

    if (result.rows.length === 1) {
      req.session.user = {
        id: result.rows[0].id,
        name: result.rows[0].name,
        email: result.rows[0].email,
        role: 'user',
      };
      return res.redirect('/dashboard');
    } else {
      return res.send('⚠️ Invalid credentials');
    }
  } catch (err) {
    console.error(err);
    res.send('❌ Error during login');
  }
});



app.get('/dashboard', async (req, res) => {
  if (!req.session.user) return res.redirect('/');
  const userId = req.session.user.email; // use the logged-in session user ID
  console.log('User ID:', userId);
  
  try {
    const response = await axios.get('https://attendance-sys-2z2o.onrender.com/api');
    const allEmployees = response.data.employees;

    const currentEmployee = allEmployees.find(emp => emp.email === userId); // use == to match int & string if needed
     const result = await pool.query('SELECT * FROM transactions WHERE email = $1 ORDER BY date DESC', [userId]);
    const transactions = result.rows;

    const income = transactions.filter(t => t.type === 'income').reduce((sum, t) => sum + parseFloat(t.amount), 0);
    const expense = transactions.filter(t => t.type === 'expense').reduce((sum, t) => sum + parseFloat(t.amount), 0);
    const balance = income - expense;

    const youtubeIdeas = await pool.query('SELECT * FROM youtube_ideas');
    const ideaCount = youtubeIdeas.rows.length;
    if (!currentEmployee) {
      return res.status(404).send('Employee not found in records.');
    }

    res.render('home', {
      user: req.session.user,
      employeeData: currentEmployee,
      income,
      expense,
      balance,
      ideaCount
    });

  } catch (error) {
    console.error('Error fetching API data:', error.message);
    res.status(500).send('Error loading dashboard');
  }
});


// 
// Get all shoots for logged-in user
app.get('/api/shoots', checkAuth, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM video_shoots WHERE user_id = $1 ORDER BY scheduled_date ASC',
      [req.session.user.id]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Add new shoot plan
app.post('/api/shoots', checkAuth, async (req, res) => {
  const { title, type, scheduled_date } = req.body;
  try {
    const result = await pool.query(
      'INSERT INTO video_shoots (user_id, title, type, scheduled_date) VALUES ($1, $2, $3, $4) RETURNING *',
      [req.session.user.id, title, type, scheduled_date]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Update shoot status
app.put('/api/shoots/:id/status', checkAuth, async (req, res) => {
  const { id } = req.params;
  const { status } = req.body;
  try {
    const result = await pool.query(
      'UPDATE video_shoots SET status = $1 WHERE id = $2 AND user_id = $3 RETURNING *',
      [status, id, req.session.user.id]
    );
    if (result.rowCount === 0) return res.status(404).json({ error: 'Shoot not found' });
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
// Get all dev tasks for logged-in user
app.get('/api/devtasks', checkAuth, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM dev_tasks WHERE user_id = $1 ORDER BY created_at DESC',
      [req.session.user.id]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Create new dev task
app.post('/api/devtasks', checkAuth, async (req, res) => {
  const { title, description, stage } = req.body;
  try {
    const result = await pool.query(
      `INSERT INTO dev_tasks (user_id, title, description, stage) 
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [req.session.user.id, title, description, stage]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Update dev task (status and/or stage)
app.put('/api/devtasks/:id', checkAuth, async (req, res) => {
  const { id } = req.params;
  const { status, stage } = req.body;
  try {
    const result = await pool.query(
      `UPDATE dev_tasks SET status = COALESCE($1, status), stage = COALESCE($2, stage), updated_at = CURRENT_TIMESTAMP
       WHERE id = $3 AND user_id = $4 RETURNING *`,
      [status, stage, id, req.session.user.id]
    );
    if (result.rowCount === 0) return res.status(404).json({ error: 'Task not found' });
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Delete dev task (optional)
app.delete('/api/devtasks/:id', checkAuth, async (req, res) => {
  const { id } = req.params;
  try {
    const result = await pool.query(
      'DELETE FROM dev_tasks WHERE id = $1 AND user_id = $2',
      [id, req.session.user.id]
    );
    if (result.rowCount === 0) return res.status(404).json({ error: 'Task not found' });
    res.json({ message: 'Task deleted' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});


// --- Time Slots ---
const timeSlots = {
  morning: { start: '06:00', end: '10:00' },
  afternoon: { start: '12:00', end: '14:00' },
  evening: { start: '16:00', end: '18:00' },
  night: { start: '20:00', end: '22:00' }
};

function isWithinTimeSlot(slot) {
  const now = new Date();
  const dateStr = now.toISOString().split('T')[0];
  const start = new Date(`${dateStr}T${timeSlots[slot].start}:00`);
  const end = new Date(`${dateStr}T${timeSlots[slot].end}:00`);
  return now >= start && now <= end;
}

// --- Auth Check ---
function checkAuth(req, res, next) {
  if (!req.session.user) return res.redirect('/');
  next();
}

// ======================


// app: Upload video
app.post('/yt/upload', checkAuth, upload.single('video'), async (req, res) => {
  const { title, description } = req.body;
  const userId = req.session.user.id;
  const filename = req.file.filename;

  try {
    await pool.query(
      'INSERT INTO videos (user_id, title, description, filename, upload_date) VALUES ($1, $2, $3, $4, NOW())',
      [userId, title, description, filename]
    );
    res.redirect('/yt');
  } catch (err) {
    console.error(err);
    res.status(500).send('Upload failed');
  }
});

// app: Get all videos + user subscriptions etc
app.get('/yt', checkAuth, async (req, res) => {
 try {
    const videos = await pool.query('SELECT * FROM youtube_videos ORDER BY created_at DESC');
    const ideas = await pool.query('SELECT * FROM youtube_ideas ORDER BY created_at DESC');

    const analytics = await pool.query(`
      SELECT va.*, v.title 
      FROM youtube_analytics va
      JOIN youtube_videos v ON va.video_id = v.id
      ORDER BY va.recorded_at DESC
    `);



    res.render('youtube_dashboard', {
      videos: videos.rows,
      ideas: ideas.rows,
      
      analytics: analytics.rows,


    });
  } catch (err) {
    console.error(err);
    res.status(500).send('Error loading dashboard');
  }
});

app.post('/youtube/add-video', async (req, res) => {
  const {
    title, topic, shoot_date, edit_status, edit_app,
    upload_status, tags, description, video_file_link, thumbnail_link
  } = req.body;

  try {
    await pool.query(
      `INSERT INTO youtube_videos 
        (title, topic, shoot_date, edit_status, edit_app, upload_status, tags, description, video_file_link, thumbnail_link) 
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [title, topic, shoot_date, edit_status, edit_app, upload_status, tags, description, video_file_link, thumbnail_link]
    );
    res.redirect('/yt');
  } catch (err) {
    console.error(err);
    res.send('Error adding video.');
  }
});
app.post('/youtube/add-idea', async (req, res) => {
  const { idea_title, idea_type, priority, notes } = req.body;

  try {
    await pool.query(
      `INSERT INTO youtube_ideas (idea_title, idea_type, priority, notes) VALUES ($1, $2, $3, $4)`,
      [idea_title, idea_type, priority, notes]
    );
    res.redirect('/yt');
  } catch (err) {
    console.error(err);
    res.send('Error adding idea.');
  }
});
app.post('/youtube/add-analytics', async (req, res) => {
  const { video_id, views, likes, comments, subs } = req.body;

  try {
    await pool.query(
      `INSERT INTO youtube_analytics (video_id, views, likes, comments, subs) VALUES ($1, $2, $3, $4, $5)`,
      [video_id, views, likes, comments, subs]
    );
    res.redirect('/yt');
  } catch (err) {
    console.error(err);
    res.send('Error saving analytics.');
  }
});


app.get('/search', async (req, res) => {
  const { query } = req.query;

  try {
    const videos = await pool.query(
      `SELECT * FROM youtube_videos WHERE title ILIKE $1 OR topic ILIKE $1`,
      [`%${query}%`]
    );
    const ideas = await pool.query(
      `SELECT * FROM youtube_ideas WHERE idea_title ILIKE $1 OR idea_type ILIKE $1`,
      [`%${query}%`]
    );

    res.render('search_results', {
      videos: videos.rows,
      ideas: ideas.rows,
      query
    });
  } catch (err) {
    console.error(err);
    res.send('Error performing search.');
  }
});

app.post('/youtube/videos/edit/:id', async (req, res) => {
  const id = req.params.id;
  console.log('Edit request for ID:', id);
  console.log('Body:', req.body);
  const {
    title, topic, shoot_date, edit_status, edit_app,
    upload_status, tags, description, video_file_link, thumbnail_link
  } = req.body;
  try {
    await pool.query(
      `UPDATE youtube_videos 
       SET title = $1, topic = $2, shoot_date = $3, edit_status = $4, edit_app = $5,
           upload_status = $6, tags = $7, description = $8, video_file_link = $9, thumbnail_link = $10
       WHERE id = $11`,
      [title, topic, shoot_date, edit_status, edit_app, upload_status, tags, description, video_file_link, thumbnail_link, id]
    );
    res.redirect('/yt');
  } catch (err) {
    console.error(err);
    res.send('Error updating video.');
  }
}

);
  
app.post('/youtube/videos/delete/:id', async (req, res) => {
  const id = req.params.id;
  console.log('Delete request for ID:', id);
  try {
    await pool.query('DELETE FROM youtube_videos WHERE id = $1', [id]);
    res.redirect('/yt');

  } catch (err) {
    console.error(err);
    res.send('Error deleting video.');
  }

});

app.get("/projects", checkAuth, (req, res) => {
  res.render("projects");
});
// ======================

// ======================
app.get("/settings", checkAuth, (req, res) => {
  res.render('settings');
});

// Logout
app.get('/logout', (req, res) => {
  req.session.destroy(() => {
    res.redirect('/');
  });
});

app.get('/admin', (req, res) => {
  res.render('admin');
});



// Inside app.js or apps
// app.get('/admin/unlock', async (req, res) => {
//   const result = await pool.query(`
//     SELECT r.*, u.name AS user_name 
//     FROM unlock_requests r 
//     JOIN users u ON r.user_id = u.id 
//     WHERE r.status = 'pending'
//     ORDER BY r.date DESC
//   `);
//   res.render('admin', { unlockRequests: result.rows });
// });

// app.post('/admin/unlock/appove', async (req, res) => {
//   const { id, user_id, date, slot } = req.body;
//   const lockedField = `${slot}_locked`;

//   await pool.query(`
//     UPDATE attendance 
//     SET ${lockedField} = FALSE 
//     WHERE user_id = $1 AND date = $2
//   `, [user_id, date]);

//   await pool.query(`UPDATE unlock_requests SET status = 'appoved' WHERE id = $1`, [id]);

//   res.redirect('/admin/unlock');
// });

// Home with optional filtering
app.get('/todo',checkAuth ,async  (req, res) => {
const embedUrl = 'https://todo-app-e1wk.onrender.com/'; // Replace with the site you want to embed
  res.render('todo', { embedUrl });
});

app.get('/api/session', checkAuth, async (req, res) => {
  try {
    console.log('API called to get session data');

    // Check if session user exists
    if (!req.session.user) {
      return res.status(401).json({ error: 'User not authenticated' });
    }

    // Prepare response JSON
    const userData = {
      userId: req.session.user.id,
      email: req.session.user.email,
      name: req.session.user.name,
      role: req.session.user.role
    };

    // Send the user data as API response
    res.json(userData);

  } catch (err) {
    console.error('Error fetching session data:', err);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

// Dashboard - Get User's finance data dynamically
app.get('/finance', checkAuth, async (req, res) => {
  try {
    const email = req.session.user.email;
    const result = await pool.query('SELECT * FROM transactions WHERE email = $1 ORDER BY date DESC', [email]);
    const transactions = result.rows;

    const income = transactions.filter(t => t.type === 'income').reduce((sum, t) => sum + parseFloat(t.amount), 0);
    const expense = transactions.filter(t => t.type === 'expense').reduce((sum, t) => sum + parseFloat(t.amount), 0);
    const balance = income - expense;

    res.render('finance', {
      transactions,
      income,    // send as 'income'
      expense,   // send as 'expense'
      balance,   // send as 'balance'
      user: req.session.user
    });

  } catch (err) {
    console.error(err);
    res.status(500).send("Error loading finance page");
  }
});



// Add Transaction
app.post('/add-transaction', async (req, res) => {
  try {
    if (!req.session.user) {
      return res.redirect('/');
    }
    const { type, title, amount } = req.body;
    const email = req.session.user.email;

    await pool.query(
      'INSERT INTO transactions (type, title, amount, email) VALUES ($1, $2, $3, $4)',
      [type, title, amount, email]
    );
    res.redirect('/finance');
  } catch (err) {
    console.error(err);
    res.status(500).send("Error adding transaction");
  }
});

// Delete Transaction
app.post('/delete-transaction/:id', async (req, res) => {
  try {
    if (!req.session.user) {
      return res.redirect('/');
    }
    const id = req.params.id;
    const email = req.session.user.email;

    await pool.query('DELETE FROM transactions WHERE id = $1 AND email = $2', [id, email]);
    res.redirect('/finance');
  } catch (err) {
    console.error(err);
    res.status(500).send("Error deleting transaction");
  }
});

// Edit Transaction
app.post('/edit-transaction/:id', async (req, res) => {
  try {
    if (!req.session.user) {
      return res.redirect('/');
    }
    const id = req.params.id;
    const { title, amount, type } = req.body;
    const email = req.session.user.email;

    await pool.query(
      'UPDATE transactions SET title = $1, amount = $2, type = $3 WHERE id = $4 AND email = $5',
      [title, amount, type, id, email]
    );
    res.redirect('/finance');
  } catch (err) {
    console.error(err);
    res.status(500).send("Error updating transaction");
  }
});

// Generate Bill PDF (restricted to user)
// Generate Bill PDF


app.get('/generate-bill/:id', async (req, res) => {
  try {
    if (!req.session.user) {
      return res.redirect('/');
    }
    const email = req.session.user.email;
    const username = req.session.user.name || email;

    const id = req.params.id;
    const result = await pool.query('SELECT * FROM transactions WHERE id = $1 AND email = $2', [id, email]);
    if (result.rowCount === 0) {
      return res.status(404).send('Transaction not found');
    }

    const t = result.rows[0];
    const doc = new PDFDocument({ margin: 50 });
    res.setHeader('Content-disposition', 'attachment; filename=Finance_Bill.pdf');
    res.setHeader('Content-type', 'application/pdf');
    doc.pipe(res);

    // HEADER
    doc.fillColor('#003366').fontSize(26).text("D's Office Finance System", { align: 'center' });
    doc.fontSize(14).fillColor('#555555').text("Finance Transaction Bill", { align: 'center' });
    doc.moveDown().fontSize(10).fillColor('#000000');
    doc.text(`Date of Generation: ${new Date().toLocaleDateString()}`, { align: 'right' });
    doc.text(`Generated By: ${username}`, { align: 'right' });
    doc.moveDown(1);

    // COMPANY INFO
    doc.rect(50, doc.y, 80, 80).strokeColor('#CCCCCC').stroke();
    doc.fontSize(8).fillColor('#999999').text('LOGO', 60, doc.y + 30);
    doc.fontSize(12).fillColor('#000000')
        .text("D's Office Pvt Ltd", 150, doc.y - 60)
        .text("Finance Department", 150, doc.y - 40)
        .text("Email: support@dsoffice.com", 150, doc.y - 20)
        .text("Phone: +91 99999 99999", 150, doc.y);
    doc.moveDown(5);

    // TABLE HEADER
    doc.fontSize(16).fillColor('#003366').text('Transaction Details', { underline: true });
    doc.moveDown(1);

    // TABLE DATA
    const tableData = [
      { label: 'Transaction ID', value: t.id },
      { label: 'Title', value: t.title },
      { label: 'Type', value: t.type.toUpperCase() },
      { label: 'Amount', value: `₹ ${t.amount}` },
      { label: 'Date', value: new Date(t.date).toLocaleDateString() }
    ];

    // Start drawing rows
    const startX = 50;
    const labelWidth = 200;
    const valueWidth = 300;
    tableData.forEach((item, index) => {
      const bgColor = index % 2 === 0 ? '#f8f9fa' : '#ffffff';
      doc.rect(startX, doc.y, labelWidth + valueWidth, 25).fill(bgColor).strokeColor('#DDDDDD').stroke();

      doc.fillColor('#000000').fontSize(12)
        .text(item.label, startX + 10, doc.y + 7, { width: labelWidth - 20, align: 'left' })
        .text(item.value, startX + labelWidth + 10, doc.y + 7, { width: valueWidth - 20, align: 'left' });

      doc.moveDown(1);
    });

    doc.moveDown(2);

    // SUMMARY BOX
    doc.fillColor('#003366').rect(startX, doc.y, labelWidth + valueWidth, 50).fill();
    doc.fillColor('#ffffff').fontSize(14)
      .text('Total Amount:', startX + 10, doc.y + 15, { width: labelWidth - 20, align: 'left' })
      .font('Helvetica-Bold')
      .text(`₹ ${t.amount}`, startX + labelWidth + 10, doc.y + 15, { width: valueWidth - 20, align: 'left' });
    doc.moveDown(5);

    // FOOTER
    doc.fontSize(10).fillColor('#999999')
      .text('Thank you for using D’s Office Finance System', { align: 'center' })
      .moveDown(0.5)
      .text('This is a system-generated bill. No signature required.', { align: 'center' });

    doc.end();

  } catch (err) {
    console.error(err);
    res.status(500).send("Error generating bill");
  }
});




app.get('/account', checkAuth, async (req, res) => {
    const email = req.session.user.email;
    const result = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
    res.render('account', { user: result.rows[0] });
});



// Edit Profile (submit form)
// Edit Profile (submit form)
app.post('/profile/edit', checkAuth, uploadP.single('photo'), async (req, res) => {
    const { username, phone, bio, department, address } = req.body;
    const email = req.session.user.email;

    let query, params;

    if (req.file) {
        // If photo uploaded
        query = `
            UPDATE users 
            SET username = $1, phone = $2, bio = $3, photo = $4, photo_mime = $5, department = $6, address = $7 
            WHERE email = $8
        `;
        params = [username, phone, bio, req.file.buffer, req.file.mimetype, department, address, email];
    } else {
        // If no photo uploaded
        query = `
            UPDATE users 
            SET username = $1, phone = $2, bio = $3, department = $4, address = $5 
            WHERE email = $6
        `;
        params = [username, phone, bio, department, address, email];
    }

    await pool.query(query, params);
    res.redirect('/account');
});

// Change Password
app.post('/change-password', async (req, res) => {
    const { currentPassword, newPassword } = req.body;
    const email = req.session.user.email;

    const result = await pool.query('SELECT password FROM users WHERE email = $1', [email]);
    const valid = await bcrypt.compare(currentPassword, result.rows[0].password);

    if (!valid) {
        return res.send('Current password incorrect');
    }

    const hash = await bcrypt.hash(newPassword, 10);
    await pool.query('UPDATE users SET password = $1 WHERE email = $2', [hash, email]);
    res.redirect('/account');
});
app.get('/profile/photo', checkAuth, async (req, res) => {
    const email = req.session.user.email;
    const result = await pool.query('SELECT photo, photo_mime FROM users WHERE email = $1', [email]);

    if (result.rows.length > 0 && result.rows[0].photo) {
        res.set('Content-Type', result.rows[0].photo_mime);
        res.send(result.rows[0].photo);
    } else {
        res.redirect('/default-avatar.png');  // fallback image
    }
});




app.get('/session-test', (req, res) => {
  res.send(`Session ID: ${req.session.id} <br> User: ${JSON.stringify(req.session.user)}`);
});



// ======================
// Server Start
// ======================
app.listen(3000, () => {
  console.log('🚀 D\'s Office is running at http://localhost:3000');
});

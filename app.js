const express = require('express');
const session = require('express-session');
const { Pool } = require('pg');
const pgSession = require('connect-pg-simple')(session);
const bodyParser = require('body-parser');
const path = require('path');
const multer = require('multer');
const storageP = multer.memoryStorage();  // store file directly in memory
const uploadP = multer({ storage: storageP });
const cron = require('node-cron');
const fetch = require('node-fetch'); // for calling YouTube API
const axios = require('axios');
const PDFDocument = require('pdfkit');
const app = express();
const fs = require('fs');
const webPush = require('web-push');


const ffmpeg = require('fluent-ffmpeg');
const ffmpegPath = require('ffmpeg-static');
const sharp = require('sharp');
const heicConvert = require('heic-convert');
const crypto = require('crypto');

ffmpeg.setFfmpegPath(ffmpegPath);
const puppeteer = require('puppeteer');
const server = require('http').createServer(app);
const { Server } = require('socket.io');
const io = new Server(server);
io.on('connection', (socket) => {
  console.log('🟢 New user connected');

  socket.on('edit-doc', ({ id, content }) => {
    socket.broadcast.emit('doc-updated', { id, content });
  });

  socket.on('disconnect', () => {
    console.log('🔴 User disconnected');
  });
});
// ======================
// Database Setup (PostgreSQL)
// ======================


const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  idleTimeoutMillis: 30000, // Close idle clients after 30s
  connectionTimeoutMillis: 5000, // Timeout if can't connect in 5s
  max: 10, // Limit number of clients
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
  store: new pgSession({
    pool,
    createTableIfMissing: true // Add this line
  }),
  secret: process.env.SESSION_SECRET || 'super-secret-dhruvin-key',
  resave: false,
  saveUninitialized: false,
  cookie: { secure: false, maxAge: 86400000 }
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
    const ytubeVideos = await pool.query('SELECT * FROM youtube_videos');
    const totalVideos = ytubeVideos.rows.length;
 
    /**
        <li class="list-group-item">Videos Idea: <strong><%= ideaCount  %></strong></li>
              <li class="list-group-item">Total Videos: <strong>3</strong></li>
              <li class="list-group-item">Pending Videos: <strong>2</strong></li>
              <li class="list-group-item">Scheduled Uploads: <strong>1</strong></li>
              <li class="list-group-item">Completed Uploads: <strong>3</strong></li>
     */
    if (!currentEmployee) {
      return res.status(404).send('Employee not found in records.');
    }

    res.render('home', {
      user: req.session.user,
      employeeData: currentEmployee,
      income,
      expense,
      balance,
      ideaCount,
      totalVideos

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
  SELECT a.*, v.title AS video_title 
  FROM youtube_analytics a 
  JOIN youtube_videos v ON a.video_id = v.id
  ORDER BY a.recorded_at DESC
`);

    const tasks = await pool.query('SELECT * FROM video_tasks');
    

    res.render('youtube_dashboard', {
      videos: videos.rows,
      ideas: ideas.rows,
     
      analytics: analytics.rows,
      tasks: tasks.rows,
   
    });
  } catch (err) {
    console.error(err);
    res.status(500).send('Error loading dashboard');
  }
});
app.post('/youtube/edit-analytics/:id', async (req, res) => {
  const { id } = req.params;
  const { views, likes, comments, subs } = req.body;

  try {
    await pool.query(
      `UPDATE youtube_analytics SET views = $1, likes = $2, comments = $3, subs = $4 WHERE id = $5`,
      [views, likes, comments, subs, id]
    );
    res.redirect('/yt');
  } catch (err) {
    console.error(err);
    res.send('Error updating analytics.');
  }
});
app.post('/youtube/delete-analytics/:id', async (req, res) => {
  const { id } = req.params;

  try {
    await pool.query(`DELETE FROM youtube_analytics WHERE id = $1`, [id]);
    res.redirect('/yt');
  } catch (err) {
    console.error(err);
    res.send('Error deleting analytics.');
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

app.post('/youtube/edit-idea/:id', async (req, res) => {
  const { id } = req.params;
  const { idea_title, idea_type, priority, status, notes } = req.body;

  try {
    await pool.query(
      `UPDATE youtube_ideas SET idea_title=$1, idea_type=$2, priority=$3, status=$4, notes=$5 WHERE id=$6`,
      [idea_title, idea_type, priority, status, notes, id]
    );
    res.redirect('/yt');
  } catch (err) {
    console.error(err);
    res.send('Error updating idea.');
  }
});
app.post('/youtube/delete-idea/:id', async (req, res) => {
  const { id } = req.params;
  console.log("Delete request for Idea ID:", id); // ⬅️ THIS must show in your terminal

  try {
    const result = await pool.query(`DELETE FROM youtube_ideas WHERE id = $1`, [id]);
    console.log("Delete Result:", result); // ⬅️ Check rows affected
    res.redirect('/yt');
  } catch (err) {
    console.error(err);
    res.send('Error deleting idea.');
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
app.use((req, res, next) => {
  res.locals.success = req.session.success;
  res.locals.error = req.session.error;
  delete req.session.success;
  delete req.session.error;
  next();
});

app.get('/projects', checkAuth,async (req, res) => {
  try {
    const requests = await pool.query(`SELECT * FROM project_requests WHERE otp IS NOT NULL AND status = 'verified'`);
  const meetings = await pool.query(`
  SELECT m.*, r.name AS client_name, r.project_type 
  FROM project_meetings m
  JOIN project_requests r ON m.project_id = r.id
  WHERE m.status != 'completed'
`);

   
    const services = await pool.query(`SELECT * FROM project_services`);
    const select_project_for_meeting = await pool.query(`SELECT * FROM project_requests WHERE status = 'accepted'`);

    // Get project IDs of completed meetings
    const completedMeetingProjects = await pool.query(`SELECT project_id FROM project_meetings WHERE status = 'completed'`);
    const projectIds = completedMeetingProjects.rows.map(r => r.project_id);

    let projectsForMeeting = [];
    if (projectIds.length > 0) {
      const placeholders = projectIds.map((_, i) => `$${i + 1}`).join(',');
      const result = await pool.query(`SELECT * FROM project_requests WHERE id IN (${placeholders})`, projectIds);
      projectsForMeeting = result.rows;
    }

    // Optional: Fetch project teams
    const updateStatusPromises = await pool.query(`
      SELECT pt.project_id, pt.team_name, pr.name AS project_name
      FROM project_teams pt
      JOIN project_requests pr ON pt.project_id = pr.id
    `);

    const deployedProjects = await pool.query(`SELECT project_id FROM project_status WHERE status = 'deployed'`);
const deployedIds = deployedProjects.rows.map(row => row.project_id);

let project_services = [];
if (deployedIds.length > 0) {
  const placeholders = deployedIds.map((_, i) => `$${i + 1}`).join(',');
  const query = `SELECT id, name FROM project_requests WHERE id IN (${placeholders})`;
  const result = await pool.query(query, deployedIds);
  project_services = result.rows;
}

const projects = await pool.query(`
  SELECT ps.project_id, pr.name 
  FROM project_status ps
  JOIN project_requests pr ON ps.project_id = pr.id
`);

 const result = await pool.query('SELECT name, mobile, email FROM project_requests WHERE otp IS NULL');

    res.render('projects', {
      title: "Projects",
      requests: requests.rows,
      meetings: meetings.rows,
      projects: projects.rows,
      services: services.rows,
      success: req.session.success,
      error: req.session.error,
      select_project_for_meeting: select_project_for_meeting.rows,
      projectsForMeeting: projectsForMeeting,
      updateStatusPromises: updateStatusPromises.rows,
      project_services: project_services ,
      projects: projects.rows,
  services: services.rows,
   selectedProject: req.session.selectedProject || null,
  selectedServices: req.session.selectedServices || [],
  pendingRequests: result.rows
    });

    delete req.session.success;
    delete req.session.error;
    // Clear after render
delete req.session.selectedProject;
delete req.session.selectedServices;
  } catch (err) {
    console.error(err);
    req.session.error = "Failed to load projects page.";
    res.redirect('/');
  }
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
  'INSERT INTO transactions (type, title, amount, email, date) VALUES ($1, $2, $3, $4, NOW())',
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
  const userEmail = req.session.user.email;
  const userDept = req.session.user.department;

  try {
    // Fetch user info
    const userResult = await pool.query('SELECT * FROM users WHERE email = $1', [userEmail]);
    const user = userResult.rows[0];
    
    // Fetch notifications
    const notificationResult = await pool.query(
      `SELECT * FROM notifications
       WHERE (recipient_email IS NULL AND (department IS NULL OR department = $1))
          OR recipient_email = $2
       ORDER BY created_at DESC`,
      [userDept, userEmail]
    );

    const notifications = notificationResult.rows;

    // Render account page with both
    res.render('account', { user, notifications });

  } catch (err) {
    console.error(err);
    res.status(500).send('Failed to load account page');
  }
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




// Show repositories
app.get('/drive', checkAuth, async (req, res) => {
  const repos = await pool.query(
    'SELECT * FROM repositories WHERE user_id = $1 AND parent_id IS NULL',
    [req.session.user.id]
  );

  const usage = await getUserStorageUsage(req.session.user.id);
  const limit = 10 * 1024 * 1024 * 1024; // 10 GB

  res.render('drive', { 
    repos: repos.rows, 
    storageUsed: usage, 
    storageLimit: limit 
  });
});


// Create new repository
app.post('/repo/create', checkAuth, async (req, res) => {
  const { name, parent_id } = req.body;
  await pool.query('INSERT INTO repositories (user_id, name, parent_id) VALUES ($1, $2, $3)', [
    req.session.user.id, name, parent_id || null
  ]);
  res.redirect('/drive');
});
// Upload file into specific repository
// Multer in-memory storage (✔️ works with Render)
const uploadD = multer({ storage: multer.memoryStorage() });

// Upload route using memory and DB storage
app.post('/upload/:repoId', checkAuth, uploadD.single('file'), async (req, res) => {
  try {
    const file = req.file;
    const repoId = req.params.repoId;
    const userId = req.session.user.id;
    const shareToken = crypto.randomBytes(16).toString('hex');

    if (!file) return res.status(400).send("No file uploaded");

    // Storage limit check (10GB/user)
    const usage = await getUserStorageUsage(userId);
    if (usage + file.size > 10 * 1024 * 1024 * 1024) {
      return res.send("❌ Storage limit exceeded! You have only 10 GB storage limit.");
    }

    // Save to DB
    await pool.query(`
      INSERT INTO files (repository_id, user_id, filename, filetype, filesize, filedata, uploaded_by_name, share_token)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
    `, [
      repoId,
      userId,
      file.originalname,
      file.mimetype,
      file.size,
      file.buffer,
      req.session.user.email,
      shareToken
    ]);

    res.redirect(`/repo/${repoId}`);
  } catch (err) {
    console.error("Upload error:", err);
    res.status(500).send("Internal Server Error");
  }
});

// Helper to get user storage usage
async function getUserStorageUsage(userId) {
  const result = await pool.query(
    'SELECT COALESCE(SUM(filesize), 0) AS total FROM files WHERE user_id = $1',
    [userId]
  );
  return parseInt(result.rows[0].total);
}



app.get('/repo/:repoId', checkAuth, async (req, res) => {
  const repo = await pool.query('SELECT * FROM repositories WHERE id = $1 AND user_id = $2', [req.params.repoId, req.session.user.id]);
  const files = await pool.query('SELECT * FROM files WHERE repository_id = $1 AND user_id = $2', [req.params.repoId, req.session.user.id]);
  
  // Fetch all folders for move modal
  const allRepos = await pool.query('SELECT * FROM repositories WHERE user_id = $1', [req.session.user.id]);

  res.render('repo', { repo: repo.rows[0], files: files.rows, allRepos: allRepos.rows });
});


app.get('/file/download/:fileId', checkAuth, async (req, res) => {
  const fileId = req.params.fileId;
  const fileResult = await pool.query(
    'SELECT * FROM files WHERE id = $1 AND user_id = $2',
    [fileId, req.session.user.id]
  );

  if (fileResult.rowCount === 0) return res.status(404).send("File not found");

  const file = fileResult.rows[0];
  const filePath = path.join(__dirname, file.storage_path);

  if (!fs.existsSync(filePath)) {
    return res.status(404).send("File does not exist on server");
  }

  res.download(filePath, file.filename);
});


// View file inline from DB
app.get('/file/view/:fileId', checkAuth, async (req, res) => {
  const { fileId } = req.params;
  const result = await pool.query('SELECT * FROM files WHERE id = $1 AND user_id = $2', [fileId, req.session.user.id]);
  if (result.rowCount === 0) return res.status(404).send("File not found");

  const file = result.rows[0];
  res.setHeader('Content-Type', file.filetype);
  res.setHeader('Content-Disposition', `inline; filename="${file.filename}"`);
  res.send(file.filedata);
});

// Download file from DB
app.get('/file/download/:fileId', checkAuth, async (req, res) => {
  const { fileId } = req.params;
  const result = await pool.query('SELECT * FROM files WHERE id = $1 AND user_id = $2', [fileId, req.session.user.id]);
  if (result.rowCount === 0) return res.status(404).send("File not found");

  const file = result.rows[0];
  res.setHeader('Content-Type', file.filetype);
  res.setHeader('Content-Disposition', `attachment; filename="${file.filename}"`);
  res.send(file.filedata);
});

// CREATE FOLDER
app.post('/repo/create', checkAuth, async (req, res) => {
  const { name, parent_id } = req.body;
  await pool.query(
    'INSERT INTO repositories (user_id, name, parent_id) VALUES ($1, $2, $3)',
    [req.session.user.id, name, parent_id || null]
  );
  res.redirect('/drive');
});

// DELETE FOLDER (recursive)
app.post('/repo/delete/:repoId', checkAuth, async (req, res) => {
  const repoId = req.params.repoId;

  // Delete files inside folder
  await pool.query('DELETE FROM files WHERE repository_id = $1 AND user_id = $2', [repoId, req.session.user.id]);

  // Delete subfolders recursively
  async function deleteSubfolders(id) {
    const subRepos = await pool.query('SELECT id FROM repositories WHERE parent_id = $1 AND user_id = $2', [id, req.session.user.id]);
    for (const sub of subRepos.rows) {
      await deleteSubfolders(sub.id);
    }
    await pool.query('DELETE FROM repositories WHERE id = $1 AND user_id = $2', [id, req.session.user.id]);
  }

  await deleteSubfolders(repoId);
  res.redirect('/drive');
});

// RENAME FOLDER
app.post('/repo/rename/:repoId', checkAuth, async (req, res) => {
  const { name } = req.body;
  await pool.query('UPDATE repositories SET name = $1 WHERE id = $2 AND user_id = $3', [name, req.params.repoId, req.session.user.id]);
  res.redirect('/drive');
});

// UPLOAD FILE (already working)
app.post('/upload/:repoId', upload.single('file'), async (req, res) => {
  const file = req.file;
  const repoId = req.params.repoId;
  const userId = req.session.user.id; // adjust based on your auth system

  if (!file) return res.status(400).send('No file uploaded.');

  await pool.query(`
    INSERT INTO files (filename, filetype, filesize, repository_id, uploaded_by, filedata, uploaded_at)
    VALUES ($1, $2, $3, $4, $5, $6, NOW())
  `, [
    file.originalname,
    file.mimetype,
    file.size,
    repoId,
    userId,
    file.buffer
  ]);

  res.redirect('/repo/' + repoId);
});

// DELETE FILE (already working)
app.post('/file/delete/:fileId', checkAuth, async (req, res) => {
  const fileId = req.params.fileId;
  const file = await pool.query('SELECT * FROM files WHERE id = $1 AND user_id = $2', [fileId, req.session.user.id]);
  if (file.rowCount === 0) return res.send("File not found");

  // Delete from disk
  const fullPath = path.join(__dirname, file.rows[0].storage_path);
  if (fs.existsSync(fullPath)) fs.unlinkSync(fullPath);

  await pool.query('DELETE FROM files WHERE id = $1 AND user_id = $2', [fileId, req.session.user.id]);
  res.redirect(`/repo/${file.rows[0].repository_id}`);
});

// RENAME FILE
app.post('/file/rename/:fileId', checkAuth, async (req, res) => {
  const { newname } = req.body;
  const fileId = req.params.fileId;
  const file = await pool.query('SELECT * FROM files WHERE id = $1 AND user_id = $2', [fileId, req.session.user.id]);
  if (file.rowCount === 0) return res.send("File not found");

  await pool.query('UPDATE files SET filename = $1 WHERE id = $2 AND user_id = $3', [newname, fileId, req.session.user.id]);
  res.redirect(`/repo/${file.rows[0].repository_id}`);
});

// MOVE FILE TO ANOTHER FOLDER
app.post('/file/move/:fileId', checkAuth, async (req, res) => {
  const { targetRepo } = req.body;
  const fileId = req.params.fileId;
  await pool.query('UPDATE files SET repository_id = $1 WHERE id = $2 AND user_id = $3', [targetRepo, fileId, req.session.user.id]);
  res.redirect(`/drive`);
});

// DOWNLOAD FILE (already working)
app.get('/file/download/:fileId', checkAuth, async (req, res) => {
  const fileId = req.params.fileId;
  
  const file = await pool.query('SELECT * FROM files WHERE id = $1 AND user_id = $2', [fileId, req.session.user.id]);
  if (file.rowCount === 0) return res.status(404).send("File not found");

  const fullPath = path.join(__dirname, file.rows[0].storage_path);
  if (!fs.existsSync(fullPath)) return res.status(404).send("File not found on disk");

  res.download(fullPath, file.rows[0].filename);
});

// VIEW FILE INLINE (already working)
app.get('/file/view/:fileId', checkAuth, async (req, res) => {
  const fileId = req.params.fileId;
  const file = await pool.query('SELECT * FROM files WHERE id = $1 AND user_id = $2', [fileId, req.session.user.id]);
  if (file.rowCount === 0) return res.status(404).send("File not found");

  const fullPath = path.join(__dirname, file.rows[0].storage_path);
  if (!fs.existsSync(fullPath)) return res.status(404).send("File not found on disk");

  res.setHeader('Content-Type', file.rows[0].filetype);
  res.setHeader('Content-Disposition', `inline; filename="${file.rows[0].filename}"`);
  fs.createReadStream(fullPath).pipe(res);
});

// DOWNLOAD FILE (already working)
app.get('/file/download/:fileId', checkAuth, async (req, res) => {
  const fileId = req.params.fileId;
  const file = await pool.query('SELECT * FROM files WHERE id = $1 AND user_id = $2', [fileId, req.session.user.id]);
  if (file.rowCount === 0) return res.status(404).send("File not found");

  const fullPath = path.join(__dirname, file.rows[0].storage_path);
  if (!fs.existsSync(fullPath)) return res.status(404).send("File not found on disk");

  res.download(fullPath, file.rows[0].filename);
});

// VIEW FILE INLINE (already working)
app.get('/file/view/:fileId', checkAuth, async (req, res) => {
  const fileId = req.params.fileId;
  const file = await pool.query('SELECT * FROM files WHERE id = $1 AND user_id = $2', [fileId, req.session.user.id]);
  if (file.rowCount === 0) return res.status(404).send("File not found");

  const fullPath = path.join(__dirname, file.rows[0].storage_path);
  if (!fs.existsSync(fullPath)) return res.status(404).send("File not found on disk");

  res.setHeader('Content-Type', file.rows[0].filetype);
  res.setHeader('Content-Disposition', `inline; filename="${file.rows[0].filename}"`);
  fs.createReadStream(fullPath).pipe(res);
});

app.get('/file/preview/:fileId', checkAuth, async (req, res) => {
  const fileId = req.params.fileId;

  const fileResult = await pool.query(
    'SELECT * FROM files WHERE id = $1 AND user_id = $2',
    [fileId, req.session.user.id]
  );

  if (fileResult.rowCount === 0) {
    return res.status(404).send("File not found");
  }

  const file = fileResult.rows[0];
  const filePath = path.join(__dirname, file.storage_path);

  if (!fs.existsSync(filePath)) {
    return res.status(404).send("File not found on server");
  }

  res.render('preview', { file });
});
app.get('/file/stream/:fileId', checkAuth, async (req, res) => {
  const fileId = req.params.fileId;
  const fileResult = await pool.query(
    'SELECT * FROM files WHERE id = $1 AND user_id = $2',
    [fileId, req.session.user.id]
  );

  if (fileResult.rowCount === 0) return res.status(404).send("File not found");

  const file = fileResult.rows[0];
  const filePath = path.join(__dirname, file.storage_path);

  if (!fs.existsSync(filePath)) {
    return res.status(404).send("File missing");
  }

  res.setHeader('Content-Type', file.filetype); // file.filetype should be 'video/quicktime' for .mov

  fs.createReadStream(filePath).pipe(res);
});
async function getUserStorageUsage(userId) {
  const result = await pool.query(
    'SELECT COALESCE(SUM(filesize), 0) AS total FROM files WHERE user_id = $1',
    [userId]
  );
  return parseInt(result.rows[0].total); // in bytes
}
// Generate Share Link Page
app.get('/file/share/:fileId', async (req, res) => {
    const { fileId } = req.params;
    const fileRes = await pool.query('SELECT * FROM files WHERE id = $1', [fileId]);

    if (fileRes.rowCount === 0) return res.send('File not found');

    const file = fileRes.rows[0];
    const shareLink = `${req.protocol}://${req.get('host')}/public/${file.share_token}`;

    res.render('share_page', { file, shareLink });
});
// Public Shared Link Access
app.get('/public/:token', async (req, res) => {
    const token = req.params.token;
    const fileRes = await pool.query('SELECT * FROM files WHERE share_token = $1', [token]);

    if (fileRes.rowCount === 0) return res.send('Invalid or expired link');

    const file = fileRes.rows[0];

    res.render('public_view', { file });
});
// =========================
// 📌 Unique Routes for CRUD
// =========================

// 🟢 CREATE - New Document Page

// 🟢 CREATE New Document
//// ==============================
// 🟢 LOGIN ROUTE (DEMO)
// ==============================

// ✅ Rename to match frontend
// app.get('/docs/create-new', checkAuth, (req, res) => {
//   res.render('editor', {
//     doc: { id: '', title: '', content: '' },
//     user: req.session.user.name || req.session.user.email
//   });
// });

// // ==============================
// // 📄 CREATE NEW DOC
// // ==============================
// app.post('/docs/save', checkAuth, async (req, res) => {
//   try {
 

//     const { id, title, content } = req.body;
//     const { email } = req.session.user;

//     if (!title || !content || !email) {
//       console.log("⚠️ Missing title/content/email");
//       return res.status(400).send('Missing data');
//     }

//     if (id && id.trim()) {
//       await pool.query(
//         'UPDATE documents SET title = $1, content = $2, updated_at = NOW() WHERE id = $3 AND email = $4',
//         [title, content, id, email]
//       );
//     } else {
//       await pool.query(
//         'INSERT INTO documents (id, title, content, email) VALUES ($1, $2, $3, $4)',
//         [uuidv4(), title, content, email]
//       );
//     }

//     res.sendStatus(200);
//   } catch (err) {
//     console.error("❌ Error saving document:", err);
//     res.status(500).send('❌ Internal Server Error');
//   }
// });

// // ==============================
// // 📋 LIST DOCUMENTS
// // ==============================
// app.get('/docs/list-all', checkAuth, async (req, res) => {
//   const email = req.session.user.email;
//   const result = await pool.query('SELECT * FROM documents WHERE email = $1 ORDER BY updated_at DESC', [email]);

//   res.render('list', {
//     documents: result.rows,
//     user: req.session.user.name || req.session.user.email
//   });
// });

// // ==============================
// // ❌ DELETE DOCUMENT
// // ==============================
// app.post('/docs/delete/:docId', checkAuth, async (req, res) => {
//   const { docId } = req.params;
//   const email = req.session.user.email;
//   await pool.query('DELETE FROM documents WHERE id = $1 AND email = $2', [docId, email]);
//   res.redirect('/docs/list-all');
// });

// // ==============================
// // 📥 DOWNLOAD DOCUMENT AS PDF
// // ==============================
// app.get('/docs/download/:id', checkAuth, async (req, res) => {
//   const { id } = req.params;
//   const email = req.session.user.email;
//   const { rows } = await pool.query('SELECT * FROM documents WHERE id = $1 AND email = $2', [id, email]);

//   if (!rows.length) return res.status(404).send('Document not found');
//   const doc = rows[0];

//   const browser = await puppeteer.launch();
//   const page = await browser.newPage();
//   const html = `<html><head><title>${doc.title}</title></head><body>${doc.content}</body></html>`;
//   await page.setContent(html, { waitUntil: 'domcontentloaded' });
//   const pdf = await page.pdf({ format: 'A4' });
//   await browser.close();

//   res.set({
//     'Content-Type': 'application/pdf',
//     'Content-Disposition': `attachment; filename="${doc.title}.pdf"`
//   });

//   res.send(pdf);
// });

// ==============================
// create new document



// --- FULL FINAL CODE ---

// File: app.js


const nodemailer = require('nodemailer');
const { title } = require('process');




// Email transporter
let transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: 'codewithdhruvinpatel@gmail.com',
    pass: 'jpsk vsfn qrvb yvpd'
  }
});



// STEP 1: Project Request (GET)
app.get('/project/request', (req, res) => {
  res.render('/projects', { title: "New Project Request", requests: [], meetings: [], projects: [], services: [] });
});

// STEP 1: Project Request (POST)
app.post('/project/request', async (req, res) => {
  let { name, email, mobile, address, state, country, pincode, project_type } = req.body;
  let otp = Math.floor(100000 + Math.random() * 900000);

  try {
    await pool.query(
      `INSERT INTO project_requests 
       (name, email, mobile, address, state, country, pincode, project_type, otp, status) 
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'pending')`,
      [name, email, mobile, address, state, country, pincode, project_type, otp]
    );

    await transporter.sendMail({
      from: `"D's Office" <${process.env.EMAIL_USER}>`,
      to: email,
      subject: 'OTP for Project Verification',
      html: `<h2>Your OTP is: <strong>${otp}</strong></h2>`
    });

    req.session.success = "Project request submitted! OTP sent to your email.";
  res.redirect('/projects#verify');

  } catch (err) {
    console.error(err);
    req.session.error = "Failed to submit project request.";
res.redirect('/projects#request');

  }
});

// OTP Verification
app.post('/project/verify', async (req, res) => {
  let { email, otp } = req.body;
  try {
    let result = await pool.query(
      `UPDATE project_requests SET status = 'verified', verified_at = NOW() 
       WHERE email = $1 AND otp = $2 AND status = 'pending' RETURNING *`,
      [email, otp]
    );
    req.session[result.rowCount === 0 ? 'error' : 'success'] = result.rowCount === 0
      ? "Invalid or expired OTP."
      : "Project verified successfully.";
    res.redirect('/projects#manage');
  } catch (err) {
    console.error(err);
    req.session.error = "Something went wrong during verification.";
    res.redirect('/projects#verify');
  }
});
// Route to render the verify page and fetch pending verifications
// STEP 2: Send OTP to Email (for verification only)
app.post('/project/send-otp', async (req, res) => {
  const { email } = req.body;
  const otp = Math.floor(100000 + Math.random() * 900000); // Generate new OTP

  try {
    // Update the OTP for the given email in DB
    const result = await pool.query(
      `UPDATE project_requests SET otp = $1, status = 'pending' WHERE email = $2 RETURNING *`,
      [otp, email]
    );

    if (result.rowCount === 0) {
      req.session.error = "Email not found for project request.";
      return res.redirect('/projects#verify');
    }

    // Send the OTP via email
    await transporter.sendMail({
      from: `"D's Office" <${process.env.EMAIL_USER}>`,
      to: email,
      subject: 'Your OTP for Project Verification',
      html: `<h2>Your OTP is: <strong>${otp}</strong></h2>`
    });

    req.session.success = "OTP sent successfully to your email.";
    res.redirect('/projects#verify');

  } catch (err) {
    console.error(err);
    req.session.error = "Failed to send OTP.";
    res.redirect('/projects#verify');
  }
});


// Manage Verified Requests
app.post('/project/manage', async (req, res) => {
  let { request_id, action, reason } = req.body;
  try {
    if (action === 'accept') {
      await pool.query(`UPDATE project_requests SET status = 'accepted' WHERE id = $1`, [request_id]);
    } else {
      await pool.query(`UPDATE project_requests SET status = 'rejected', rejection_reason = $2 WHERE id = $1`, [request_id, reason]);
    }
    req.session.success = `Request ${action}ed successfully.`;
   res.redirect('/projects#schedule');

  } catch (err) {
    console.error(err);
    req.session.error = "Action failed.";
    res.redirect('/projects#manage');
  }
});

// Meeting Schedule
// Meeting Schedule
app.post('/project/meeting/schedule', async (req, res) => {
  let { project_id, meeting_date, meeting_time, meeting_mode } = req.body;
  try {
    await pool.query(`INSERT INTO project_meetings (project_id, meeting_date, meeting_time, meeting_mode) VALUES ($1,$2,$3,$4)`,
      [project_id, meeting_date, meeting_time, meeting_mode]);

    let result = await pool.query(`SELECT email, name FROM project_requests WHERE id = $1`, [project_id]);
    let clientEmail = result.rows[0].email;
    let clientName = result.rows[0].name;

    await transporter.sendMail({
      from: `"D's Office" <${process.env.EMAIL_USER}>`,
      to: clientEmail,
      subject: "Meeting Scheduled",
      html: `<p>Hi ${clientName}, your meeting is on ${meeting_date} at ${meeting_time} (${meeting_mode}).</p>`
    });

    req.session.success = "Meeting scheduled and email sent.";
   res.redirect('/projects#log');

  } catch (err) {
    console.error(err);
    req.session.error = "Error scheduling meeting.";
    res.redirect('/projects#schedule');
  }
});


// Log Meeting Completion
app.post('/project/meeting/log', async (req, res) => {
  let { meeting_id, meeting_summary, next_action } = req.body;
  try {
    await pool.query(`UPDATE project_meetings SET meeting_summary = $1, next_action = $2, status = 'completed' WHERE id = $3`,
      [meeting_summary, next_action, meeting_id]);
    req.session.success = "Meeting log saved.";
    res.redirect('/projects#team');
  } catch (err) {
    console.error(err);
    req.session.error = "Failed to log meeting.";
    res.redirect('/projects#log');
  }
});

// Assign Team
app.post('/project/team/register', async (req, res) => {
  let {
    project_id, team_name, frontend_lang, backend_lang, database_used, db_service,
    member_names, member_roles, member_departments, member_emails
  } = req.body;
  try {
    let team = await pool.query(`INSERT INTO project_teams (project_id, team_name, frontend_lang, backend_lang, database_used, db_service) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
      [project_id, team_name, frontend_lang, backend_lang, database_used, db_service]);

    for (let i = 0; i < member_names.length; i++) {
      await pool.query(`INSERT INTO team_members (team_id, name, role, department, email) VALUES ($1,$2,$3,$4,$5)`,
        [team.rows[0].id, member_names[i], member_roles[i], member_departments[i], member_emails[i]]);
    }

    req.session.success = "Team assigned successfully.";
    res.redirect('/projects#status');
  } catch (err) {
    console.error(err);
    req.session.error = "Failed to assign team.";
    res.redirect('/projects#team');
  }
});

// Status Update
app.post('/project/status/update', async (req, res) => {
  let { project_id, status, estimated_delivery, deploy_date, frontend_status, backend_status, db_status, testing_status } = req.body;
  try {
    await pool.query(`
      INSERT INTO project_status (project_id, status, estimated_delivery, deploy_date)
      VALUES ($1,$2,$3,$4)
      ON CONFLICT (project_id) DO UPDATE SET status = EXCLUDED.status, estimated_delivery = EXCLUDED.estimated_delivery, deploy_date = EXCLUDED.deploy_date`,
      [project_id, status, estimated_delivery, deploy_date]);

    await pool.query(`
      INSERT INTO status_details (project_id, frontend_status, backend_status, db_status, testing_status)
      VALUES ($1,$2,$3,$4,$5)
      ON CONFLICT (project_id) DO UPDATE SET frontend_status = EXCLUDED.frontend_status, backend_status = EXCLUDED.backend_status, db_status = EXCLUDED.db_status, testing_status = EXCLUDED.testing_status, updated_at = NOW()`,
      [project_id, frontend_status, backend_status, db_status, testing_status]);

    req.session.success = "Status updated successfully.";
    res.redirect('/projects#service');
  } catch (err) {
    console.error(err);
    req.session.error = "Failed to update status.";
    res.redirect('/projects#status');
  }
});

// Register Multiple Services
app.post('/project/services/register', async (req, res) => {
  let { project_id, service_type, service_name, description, start_date, end_date, billing_type, price } = req.body;

  try {
    // If only one service is submitted, wrap values in arrays
    if (!Array.isArray(service_type)) {
      service_type = [service_type];
      service_name = [service_name];
      description = [description];
      start_date = [start_date];
      end_date = [end_date];
      billing_type = [billing_type];
      price = [price];
    }

    for (let i = 0; i < service_type.length; i++) {
      await pool.query(
        `INSERT INTO project_services 
        (project_id, service_type, service_name, description, start_date, end_date, billing_type, price)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          project_id,
          service_type[i],
          service_name[i],
          description[i],
          start_date[i],
          end_date[i] || null,
          billing_type[i],
          price[i]
        ]
      );
    }

    req.session.success = "Service(s) registered successfully.";
res.redirect('/projects#payment');

  } catch (err) {
    console.error(err);
    req.session.error = "Failed to register service(s).";
    res.redirect('/projects#service');
  }
});


// Record Payment
// Step 1: Show form to select project by name
app.get('/project/payment/start', async (req, res) => {
  const result = await pool.query(`SELECT id, name FROM project_requests`);
  res.render('/project', { projects: result.rows });
});
// Step 2: Load selected project's services and return to /projects
app.post('/project/payment/select-service', async (req, res) => {
  const { project_id } = req.body;
  console.log("BODY:", req.body);


  try {
    const project = await pool.query(`SELECT id, name FROM project_requests WHERE id = $1`, [project_id]);
    const services = await pool.query(`SELECT * FROM project_services WHERE project_id = $1`, [project_id]);

    req.session.selectedProject = project.rows[0];
    req.session.selectedServices = services.rows;

 res.redirect('/projects#payment');

  } catch (err) {
    console.error(err);
    req.session.error = 'Failed to load services.';
   res.redirect('/projects#payment');

  }
});


// Record Payment




app.post('/project/payment/register', upload.single('invoice'), async (req, res) => {
  try {
    const { project_id, service_id, payment_mode, amount, transaction_id } = req.body;

    if (!project_id || !service_id || !payment_mode || !amount || !transaction_id) {
      req.session.error = "Missing required payment fields.";
      return res.redirect('/projects');
    }

    // Get service and project info
    const [projectRes, serviceRes] = await Promise.all([
      pool.query(`SELECT name, email FROM project_requests WHERE id = $1`, [project_id]),
      pool.query(`SELECT service_name, service_type, billing_type FROM project_services WHERE id = $1`, [service_id])
    ]);

    const project = projectRes.rows[0];
    const service = serviceRes.rows[0];
    const clientEmail = project?.email;
    const clientName = project?.name;
    const date = new Date().toLocaleDateString();

    // Generate PDF Invoice
    const buffers = [];
    const doc = new PDFDocument({ margin: 50 });

    doc.on('data', buffers.push.bind(buffers));
    doc.on('end', async () => {
      const pdfBuffer = Buffer.concat(buffers);

      // Store to DB
      await pool.query(`
        INSERT INTO project_payments 
        (project_id, service_id, payment_mode, amount, transaction_id, invoice_blob)
        VALUES ($1, $2, $3, $4, $5, $6)
      `, [
        project_id,
        service_id,
        payment_mode,
        amount,
        transaction_id,
        pdfBuffer
      ]);

      // Send Email
      if (clientEmail) {
        const htmlContent = `
          <h3>Payment Receipt - D’s Office</h3>
          <p>Dear ${clientName},</p>
          <p>Thank you for your payment. Here are the details:</p>
          <ul>
            <li><strong>Project:</strong> ${clientName}</li>
            <li><strong>Service:</strong> ${service.service_name} (${service.service_type})</li>
            <li><strong>Billing Type:</strong> ${service.billing_type}</li>
            <li><strong>Amount Paid:</strong> ₹${amount}</li>
            <li><strong>Payment Mode:</strong> ${payment_mode}</li>
            <li><strong>Transaction ID:</strong> ${transaction_id}</li>
            <li><strong>Date:</strong> ${date}</li>
          </ul>
          <p>The invoice is attached with this email.</p>
          <p>Regards,<br/>D’s Office</p>
        `;

        await transporter.sendMail({
          from: process.env.EMAIL_USER,
          to: clientEmail,
          subject: "Payment Invoice - D’s Office",
          html: htmlContent,
          attachments: [{
            filename: `invoice_${Date.now()}.pdf`,
            content: pdfBuffer,
            contentType: 'application/pdf'
          }]
        });
      }

      req.session.success = "Payment recorded and invoice sent.";
    res.redirect('/projects#payment');

    });

    // Generate Invoice PDF Layout
    doc.fontSize(20).text("D's Office - Payment Invoice", { align: 'center' });
    doc.moveDown();
    doc.fontSize(12);
    doc.text(`Date: ${date}`);
    doc.text(`Transaction ID: ${transaction_id}`);
    doc.text(`Client: ${clientName}`);
    doc.moveDown();
    doc.text(`Service: ${service.service_name} (${service.service_type})`);
    doc.text(`Billing Type: ${service.billing_type}`);
    doc.text(`Payment Mode: ${payment_mode}`);
    doc.text(`Amount Paid: ₹${amount}`);
    doc.end();

  } catch (err) {
    console.error("❌ Payment Registration Error:", err);
    req.session.error = "Payment failed.";
 res.redirect('/projects#payment');

  }
});


// Run every hour
cron.schedule('0 * * * *', async () => {
  try {
    const result = await pool.query(`
      DELETE FROM notifications
      WHERE created_at < NOW() - INTERVAL '24 hours'
    `);
    console.log(`🔔 Cleared ${result.rowCount} expired notifications`);
  } catch (err) {
    console.error('Failed to clear old notifications:', err);
  }
});


// -- VAPID keys
const vapidKeys = {
 publicKey: 'BGpozbNVPwyaOj6nuG2tWpRvbLzqRpmsVA1Sm82yGLWX0NXAx6k4rawFy3bIDVPXSKqVD46F9ay4-VM9qNH0HGI',
  privateKey: 'iuA3Lecg3phNOqRSnnGLl7n18XrmLRGcB8w78Gs2Yyo'
};

webPush.setVapidDetails(
  'mailto:admin@dsoffice.com',
  vapidKeys.publicKey,
  vapidKeys.privateKey
);

// -- Save push subscription
app.post('/subscribe', async (req, res) => {
  const email = req.session.user.email;
  const subscription = req.body;

  try {
    const exists = await pool.query(
      'SELECT * FROM push_subscriptions WHERE email = $1',
      [email]
    );

    if (exists.rowCount === 0) {
      await pool.query(
        'INSERT INTO push_subscriptions (email, subscription) VALUES ($1, $2)',
        [email, subscription]
      );
    }

    res.status(201).json({ message: 'Subscribed successfully' });
  } catch (err) {
    console.error('Subscription save error:', err);
    res.status(500).send('Subscription failed');
  }
});

// -- Send Notification (Admin Only)
app.post('/notifications/send', async (req, res) => {
  const { message, recipientEmail, department } = req.body;
  let targetEmails = [];

  try {
    // DB insert
    if (department && !recipientEmail) {
      const deptUsers = await pool.query(
        `SELECT email FROM users WHERE department = $1`,
        [department]
      );

      if (deptUsers.rowCount === 0) {
        return res.status(400).send('Department not found');
      }

      targetEmails = deptUsers.rows.map(row => row.email);

      await pool.query(
        `INSERT INTO notifications (message, recipient_email, department)
         VALUES ($1, NULL, $2)`,
        [message, department]
      );

    } else if (recipientEmail) {
      const user = await pool.query(
        `SELECT email FROM users WHERE email = $1`,
        [recipientEmail]
      );

      if (user.rowCount === 0) {
        return res.status(400).send('User not found');
      }

      targetEmails = [recipientEmail];

      await pool.query(
        `INSERT INTO notifications (message, recipient_email, department)
         VALUES ($1, $2, NULL)`,
        [message, recipientEmail]
      );

    } else {
      const allUsers = await pool.query(`SELECT email FROM users`);
      targetEmails = allUsers.rows.map(row => row.email);

      await pool.query(
        `INSERT INTO notifications (message, recipient_email, department)
         VALUES ($1, NULL, NULL)`,
        [message]
      );
    }

    // Send push notification to subscribed users
    const subs = await pool.query(
      `SELECT subscription FROM push_subscriptions WHERE email = ANY($1)`,
      [targetEmails]
    );

    const payload = JSON.stringify({
      title: '🔔 New Notification',
      body: message
    });

    subs.rows.forEach(({ subscription }) => {
      webPush.sendNotification(subscription, payload).catch(err => {
        console.error('Push error:', err);
      });
    });

    res.redirect('/admin');
  } catch (err) {
    console.error('Notification send failed:', err);
    res.status(500).send('Failed to send notification');
  }
});



app.post('/notifications/delete/:id', async (req, res) => {
  const { id } = req.params;
  await pool.query('DELETE FROM notifications WHERE id = $1', [id]);
  res.redirect('/account');
});

// attendance api req
app.get('/attendance/request/api', checkAuth, async (req, res) => {
  const email = req.session.user.email;
  const Fetchpassword = await pool.query('SELECT password FROM users WHERE email = $1', [email]);
  console.log(email, Fetchpassword.rows[0].password);
  res.json({
    email: email,
    password: Fetchpassword.rows[0].password
  });

});

// ==============================
// 📄 VERSION PAGE
// ==============================






app.get('/version', (req, res) => {
  res.render('version');
});
server.listen(3000, () => {
  console.log('✅ Server running on http://localhost:4000');
});









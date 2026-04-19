const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const session = require('express-session');
const PDFDocument = require('pdfkit');

const app = express();
const PORT = process.env.PORT || 4000;

// -------------------- PATHS --------------------
const dataDir = process.env.DATA_DIR || __dirname;
const publicDir = path.join(__dirname, 'public');
const uploadsDir = path.join(dataDir, 'uploads');
const dbPath = path.join(dataDir, 'database.db');

// -------------------- ENSURE DIRECTORIES EXIST --------------------
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

// -------------------- MIDDLEWARE --------------------
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use(session({
  secret: process.env.SESSION_SECRET || 'nk-mishra-secret-key',
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: false,
    httpOnly: true,
    sameSite: 'lax'
  }
}));

// Public assets
app.use('/styles.css', express.static(path.join(publicDir, 'styles.css')));
app.use('/uploads', express.static(uploadsDir));

// -------------------- DATABASE --------------------
const db = new sqlite3.Database(dbPath, (err) => {
  if (err) {
    console.error('Database connection error:', err.message);
  } else {
    console.log('Connected to database');
  }
});

// -------------------- CREATE TABLES --------------------
db.serialize(() => {
  db.run(`
    CREATE TABLE IF NOT EXISTS clients (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      phone TEXT,
      email TEXT,
      address TEXT,
      notes TEXT
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS cases (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      caseNumber TEXT NOT NULL,
      court TEXT NOT NULL,
      nextDate TEXT NOT NULL,
      clientName TEXT NOT NULL,
      notes TEXT,
      status TEXT DEFAULT 'Pending'
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS documents (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      caseId INTEGER NOT NULL,
      fileName TEXT NOT NULL,
      filePath TEXT NOT NULL,
      uploadedAt TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `);
});

// -------------------- MULTER --------------------
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, uploadsDir);
  },
  filename: function (req, file, cb) {
    const safeName = file.originalname.replace(/\s+/g, '_');
    cb(null, `${Date.now()}-${safeName}`);
  }
});

const upload = multer({ storage });

// -------------------- AUTH MIDDLEWARE --------------------
function requireLogin(req, res, next) {
  if (req.session && req.session.loggedIn) {
    return next();
  }

  const expectsJson =
    req.xhr ||
    (req.headers.accept && req.headers.accept.includes('application/json')) ||
    (req.headers['content-type'] && req.headers['content-type'].includes('application/json'));

  if (expectsJson) {
    return res.status(401).json({ success: false, message: 'Unauthorized' });
  }

  return res.redirect('/login.html');
}

// -------------------- PUBLIC ROUTES --------------------
app.get('/', (req, res) => {
  if (req.session && req.session.loggedIn) {
    return res.redirect('/dashboard.html');
  }
  return res.sendFile(path.join(publicDir, 'index.html'));
});

app.get('/index.html', (req, res) => {
  return res.sendFile(path.join(publicDir, 'index.html'));
});

app.get('/login.html', (req, res) => {
  if (req.session && req.session.loggedIn) {
    return res.redirect('/dashboard.html');
  }
  return res.sendFile(path.join(publicDir, 'login.html'));
});

app.post('/login', (req, res) => {
  const username = (req.body.username || '').trim();
  const password = (req.body.password || '').trim();

  if (username === 'admin' && password === 'admin123') {
    req.session.loggedIn = true;
    req.session.username = username;
    return res.json({ success: true });
  }

  return res.json({ success: false, message: 'Invalid username or password' });
});

app.post('/logout', (req, res) => {
  req.session.destroy((err) => {
    if (err) {
      return res.status(500).json({ success: false, message: 'Logout failed' });
    }

    res.clearCookie('connect.sid');
    return res.json({ success: true });
  });
});

// -------------------- PROTECTED PAGE ROUTES --------------------
app.get('/dashboard.html', requireLogin, (req, res) => {
  res.sendFile(path.join(publicDir, 'dashboard.html'));
});

app.get('/clients.html', requireLogin, (req, res) => {
  res.sendFile(path.join(publicDir, 'clients.html'));
});

app.get('/cases.html', requireLogin, (req, res) => {
  res.sendFile(path.join(publicDir, 'cases.html'));
});

app.get('/hearing.html', requireLogin, (req, res) => {
  res.sendFile(path.join(publicDir, 'hearing.html'));
});

// ==================== DASHBOARD ====================
app.get('/dashboard-stats', requireLogin, (req, res) => {
  const stats = {
    totalClients: 0,
    totalCases: 0,
    upcomingHearings: 0
  };

  const today = new Date().toISOString().split('T')[0];

  db.get('SELECT COUNT(*) AS count FROM clients', [], (err, clientRow) => {
    if (err) {
      console.error('Error counting clients:', err.message);
      return res.status(500).json(stats);
    }

    stats.totalClients = clientRow ? clientRow.count : 0;

    db.get('SELECT COUNT(*) AS count FROM cases', [], (err2, caseRow) => {
      if (err2) {
        console.error('Error counting cases:', err2.message);
        return res.status(500).json(stats);
      }

      stats.totalCases = caseRow ? caseRow.count : 0;

      db.get(
        'SELECT COUNT(*) AS count FROM cases WHERE nextDate >= ?',
        [today],
        (err3, hearingRow) => {
          if (err3) {
            console.error('Error counting hearings:', err3.message);
            return res.status(500).json(stats);
          }

          stats.upcomingHearings = hearingRow ? hearingRow.count : 0;
          return res.json(stats);
        }
      );
    });
  });
});

// ==================== CLIENT ROUTES ====================
app.get('/clients', requireLogin, (req, res) => {
  const search = (req.query.search || '').trim();

  if (search) {
    const value = `%${search}%`;
    const sql = `
      SELECT * FROM clients
      WHERE name LIKE ?
         OR phone LIKE ?
         OR email LIKE ?
         OR address LIKE ?
      ORDER BY id DESC
    `;

    db.all(sql, [value, value, value, value], (err, rows) => {
      if (err) {
        console.error('Error fetching clients:', err.message);
        return res.status(500).json([]);
      }
      return res.json(rows || []);
    });
  }

  db.all('SELECT * FROM clients ORDER BY id DESC', [], (err, rows) => {
    if (err) {
      console.error('Error fetching clients:', err.message);
      return res.status(500).json([]);
    }
    return res.json(rows || []);
  });
});

app.post('/clients', requireLogin, (req, res) => {
  const name = (req.body.name || '').trim();
  const phone = (req.body.phone || '').trim();
  const email = (req.body.email || '').trim();
  const address = (req.body.address || '').trim();
  const notes = (req.body.notes || '').trim();

  if (!name) {
    return res.json({ success: false, message: 'Client name is required' });
  }

  const sql = `
    INSERT INTO clients (name, phone, email, address, notes)
    VALUES (?, ?, ?, ?, ?)
  `;

  db.run(sql, [name, phone, email, address, notes], function (err) {
    if (err) {
      console.error('Error adding client:', err.message);
      return res.json({ success: false, message: 'Error adding client' });
    }

    return res.json({
      success: true,
      message: 'Client added successfully',
      id: this.lastID
    });
  });
});

app.put('/clients/:id', requireLogin, (req, res) => {
  const clientId = parseInt(req.params.id, 10);
  const name = (req.body.name || '').trim();
  const phone = (req.body.phone || '').trim();
  const email = (req.body.email || '').trim();
  const address = (req.body.address || '').trim();
  const notes = (req.body.notes || '').trim();

  if (!name) {
    return res.json({ success: false, message: 'Client name is required' });
  }

  const sql = `
    UPDATE clients
    SET name = ?, phone = ?, email = ?, address = ?, notes = ?
    WHERE id = ?
  `;

  db.run(sql, [name, phone, email, address, notes, clientId], function (err) {
    if (err) {
      console.error('Error updating client:', err.message);
      return res.json({ success: false, message: 'Error updating client' });
    }

    return res.json({ success: true, message: 'Client updated successfully' });
  });
});

app.delete('/clients/:id', requireLogin, (req, res) => {
  const clientId = parseInt(req.params.id, 10);

  db.run('DELETE FROM clients WHERE id = ?', [clientId], function (err) {
    if (err) {
      console.error('Error deleting client:', err.message);
      return res.json({ success: false, message: 'Error deleting client' });
    }

    return res.json({ success: true, message: 'Client deleted successfully' });
  });
});

// ==================== CASE ROUTES ====================
app.get('/cases', requireLogin, (req, res) => {
  const search = (req.query.search || '').trim();

  if (search) {
    const value = `%${search}%`;
    const sql = `
      SELECT * FROM cases
      WHERE title LIKE ?
         OR caseNumber LIKE ?
         OR court LIKE ?
         OR clientName LIKE ?
         OR status LIKE ?
      ORDER BY id DESC
    `;

    db.all(sql, [value, value, value, value, value], (err, rows) => {
      if (err) {
        console.error('Error fetching cases:', err.message);
        return res.status(500).json([]);
      }
      return res.json(rows || []);
    });
  }

  db.all('SELECT * FROM cases ORDER BY id DESC', [], (err, rows) => {
    if (err) {
      console.error('Error fetching cases:', err.message);
      return res.status(500).json([]);
    }
    return res.json(rows || []);
  });
});

app.post('/cases', requireLogin, (req, res) => {
  const title = (req.body.title || '').trim();
  const caseNumber = (req.body.caseNumber || '').trim();
  const court = (req.body.court || '').trim();
  const nextDate = (req.body.nextDate || '').trim();
  const clientName = (req.body.clientName || '').trim();
  const notes = (req.body.notes || '').trim();
  const status = (req.body.status || 'Pending').trim();

  if (!title || !caseNumber || !court || !nextDate || !clientName) {
    return res.json({ success: false, message: 'Please fill all required fields' });
  }

  const sql = `
    INSERT INTO cases (title, caseNumber, court, nextDate, clientName, notes, status)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `;

  db.run(sql, [title, caseNumber, court, nextDate, clientName, notes, status], function (err) {
    if (err) {
      console.error('Error adding case:', err.message);
      return res.json({ success: false, message: 'Error saving case' });
    }

    return res.json({
      success: true,
      message: 'Case added successfully',
      id: this.lastID
    });
  });
});

app.put('/cases/:id', requireLogin, (req, res) => {
  const caseId = parseInt(req.params.id, 10);
  const title = (req.body.title || '').trim();
  const caseNumber = (req.body.caseNumber || '').trim();
  const court = (req.body.court || '').trim();
  const nextDate = (req.body.nextDate || '').trim();
  const clientName = (req.body.clientName || '').trim();
  const notes = (req.body.notes || '').trim();
  const status = (req.body.status || 'Pending').trim();

  if (!title || !caseNumber || !court || !nextDate || !clientName) {
    return res.json({ success: false, message: 'Please fill all required fields' });
  }

  const sql = `
    UPDATE cases
    SET title = ?, caseNumber = ?, court = ?, nextDate = ?, clientName = ?, notes = ?, status = ?
    WHERE id = ?
  `;

  db.run(sql, [title, caseNumber, court, nextDate, clientName, notes, status, caseId], function (err) {
    if (err) {
      console.error('Error updating case:', err.message);
      return res.json({ success: false, message: 'Error updating case' });
    }

    return res.json({ success: true, message: 'Case updated successfully' });
  });
});

app.delete('/cases/:id', requireLogin, (req, res) => {
  const caseId = parseInt(req.params.id, 10);

  db.all('SELECT * FROM documents WHERE caseId = ?', [caseId], (err, docs) => {
    if (err) {
      console.error('Error fetching case documents:', err.message);
      return res.json({ success: false, message: 'Error deleting case' });
    }

    docs.forEach((doc) => {
      const fileToDelete = path.join(uploadsDir, doc.filePath);
      if (fs.existsSync(fileToDelete)) {
        fs.unlink(fileToDelete, (unlinkErr) => {
          if (unlinkErr) {
            console.error('Error deleting file:', unlinkErr.message);
          }
        });
      }
    });

    db.run('DELETE FROM documents WHERE caseId = ?', [caseId], function (docErr) {
      if (docErr) {
        console.error('Error deleting documents:', docErr.message);
        return res.json({ success: false, message: 'Error deleting case documents' });
      }

      db.run('DELETE FROM cases WHERE id = ?', [caseId], function (caseErr) {
        if (caseErr) {
          console.error('Error deleting case:', caseErr.message);
          return res.json({ success: false, message: 'Error deleting case' });
        }

        return res.json({ success: true, message: 'Case deleted successfully' });
      });
    });
  });
});

// ==================== DOCUMENT ROUTES ====================
app.post('/upload', requireLogin, upload.single('file'), (req, res) => {
  const caseId = parseInt(req.body.caseId, 10);

  if (!req.file) {
    return res.json({ success: false, message: 'No file uploaded' });
  }

  if (!caseId) {
    return res.json({ success: false, message: 'Invalid case ID' });
  }

  const sql = `
    INSERT INTO documents (caseId, fileName, filePath)
    VALUES (?, ?, ?)
  `;

  db.run(sql, [caseId, req.file.originalname, req.file.filename], function (err) {
    if (err) {
      console.error('Error saving document:', err.message);
      return res.json({ success: false, message: 'Error saving document' });
    }

    return res.json({
      success: true,
      message: 'File uploaded successfully',
      id: this.lastID
    });
  });
});

app.get('/documents/:caseId', requireLogin, (req, res) => {
  const caseId = parseInt(req.params.caseId, 10);

  db.all(
    'SELECT * FROM documents WHERE caseId = ? ORDER BY id DESC',
    [caseId],
    (err, rows) => {
      if (err) {
        console.error('Error fetching documents:', err.message);
        return res.status(500).json([]);
      }

      return res.json(rows || []);
    }
  );
});

app.delete('/documents/:id', requireLogin, (req, res) => {
  const docId = parseInt(req.params.id, 10);

  db.get('SELECT * FROM documents WHERE id = ?', [docId], (err, doc) => {
    if (err || !doc) {
      return res.json({ success: false, message: 'Document not found' });
    }

    const fileToDelete = path.join(uploadsDir, doc.filePath);

    db.run('DELETE FROM documents WHERE id = ?', [docId], function (deleteErr) {
      if (deleteErr) {
        console.error('Error deleting document:', deleteErr.message);
        return res.json({ success: false, message: 'Error deleting document' });
      }

      if (fs.existsSync(fileToDelete)) {
        fs.unlink(fileToDelete, (unlinkErr) => {
          if (unlinkErr) {
            console.error('Error deleting file:', unlinkErr.message);
          }
        });
      }

      return res.json({ success: true, message: 'Document deleted successfully' });
    });
  });
});

// ==================== PDF EXPORT ROUTES ====================
app.get('/export-cases-pdf', requireLogin, (req, res) => {
  const search = (req.query.search || '').trim();

  let sql = 'SELECT * FROM cases ORDER BY nextDate ASC, id DESC';
  let params = [];

  if (search) {
    const value = `%${search}%`;
    sql = `
      SELECT * FROM cases
      WHERE title LIKE ?
         OR caseNumber LIKE ?
         OR court LIKE ?
         OR clientName LIKE ?
         OR status LIKE ?
      ORDER BY nextDate ASC, id DESC
    `;
    params = [value, value, value, value, value];
  }

  db.all(sql, params, (err, rows) => {
    if (err) {
      console.error('Error exporting cases PDF:', err.message);
      return res.status(500).send('Error generating PDF');
    }

    const doc = new PDFDocument({
      margin: 40,
      size: 'A4'
    });

    const fileName = search ? 'filtered-cases.pdf' : 'all-cases.pdf';

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);

    doc.pipe(res);

    doc.fontSize(18).fillColor('#163a5f').text('N.K Mishra & Associates', { align: 'center' });
    doc.moveDown(0.3).fontSize(13).fillColor('#333333').text('Case List Report', { align: 'center' });
    doc.moveDown(0.3).fontSize(10).fillColor('#666666').text(`Generated on: ${new Date().toLocaleString('en-IN')}`, { align: 'center' });

    if (search) {
      doc.moveDown(0.3).fontSize(10).fillColor('#666666').text(`Filter: ${search}`, { align: 'center' });
    }

    doc.moveDown(1);

    if (!rows || !rows.length) {
      doc.fontSize(12).fillColor('#000000').text('No cases found.');
      doc.end();
      return;
    }

    rows.forEach((item, index) => {
      if (doc.y > 720) {
        doc.addPage();
      }

      doc.roundedRect(40, doc.y, 515, 95).strokeColor('#d9e3f0').stroke();
      const startY = doc.y + 8;

      doc.fontSize(12).fillColor('#163a5f').text(`${index + 1}. ${item.title || ''}`, 50, startY, { width: 490 });

      doc
        .fontSize(10)
        .fillColor('#000000')
        .text(`Case No: ${item.caseNumber || ''}`, 50, startY + 20)
        .text(`Court: ${item.court || ''}`, 50, startY + 34)
        .text(`Client: ${item.clientName || ''}`, 50, startY + 48)
        .text(`Next Date: ${item.nextDate || ''}`, 300, startY + 20)
        .text(`Status: ${item.status || 'Pending'}`, 300, startY + 34);

      const notes = item.notes ? String(item.notes) : '-';
      doc.text(`Notes: ${notes.length > 100 ? notes.slice(0, 100) + '...' : notes}`, 50, startY + 62, {
        width: 470
      });

      doc.y = startY + 95;
    });

    doc.end();
  });
});

app.get('/export-daily-causelist-pdf', requireLogin, (req, res) => {
  const selectedDate = (req.query.date || '').trim();

  if (!selectedDate) {
    return res.status(400).send('Date is required');
  }

  const sql = `
    SELECT * FROM cases
    WHERE nextDate = ?
    ORDER BY court ASC, caseNumber ASC, id ASC
  `;

  db.all(sql, [selectedDate], (err, rows) => {
    if (err) {
      console.error('Error exporting daily cause list PDF:', err.message);
      return res.status(500).send('Error generating PDF');
    }

    const doc = new PDFDocument({
      margin: 40,
      size: 'A4'
    });

    const fileName = `daily-causelist-${selectedDate}.pdf`;

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);

    doc.pipe(res);

    doc.fontSize(18).fillColor('#163a5f').text('N.K Mishra & Associates', { align: 'center' });
    doc.moveDown(0.3).fontSize(14).fillColor('#333333').text('Daily Cause List', { align: 'center' });
    doc.moveDown(0.2).fontSize(11).fillColor('#555555').text(`Date: ${selectedDate}`, { align: 'center' });
    doc.moveDown(0.2).fontSize(10).fillColor('#777777').text(`Generated on: ${new Date().toLocaleString('en-IN')}`, { align: 'center' });

    doc.moveDown(1);

    if (!rows || !rows.length) {
      doc.fontSize(12).fillColor('#000000').text('No cases listed for the selected date.');
      doc.end();
      return;
    }

    rows.forEach((item, index) => {
      if (doc.y > 710) {
        doc.addPage();
      }

      const boxY = doc.y;

      doc
        .roundedRect(40, boxY, 515, 118)
        .strokeColor('#d9e3f0')
        .lineWidth(1)
        .stroke();

      const startY = boxY + 8;

      doc.fontSize(12).fillColor('#163a5f').text(`${index + 1}. ${item.title || ''}`, 50, startY, {
        width: 490
      });

      doc
        .fontSize(10)
        .fillColor('#000000')
        .text(`Case No: ${item.caseNumber || ''}`, 50, startY + 22)
        .text(`Client: ${item.clientName || ''}`, 50, startY + 38)
        .text(`Court: ${item.court || ''}`, 50, startY + 54)
        .text(`Date: ${item.nextDate || ''}`, 300, startY + 22)
        .text(`Status: ${item.status || 'Pending'}`, 300, startY + 38);

      const notes = item.notes ? String(item.notes) : '-';
      const shortNotes = notes.length > 140 ? notes.slice(0, 140) + '...' : notes;

      doc.text(`Notes: ${shortNotes}`, 50, startY + 74, { width: 470 });

      doc.y = boxY + 130;
    });

    doc.end();
  });
});

// -------------------- START SERVER --------------------
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT}`);
});
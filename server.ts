import "dotenv/config";
import express from "express";
import axios from "axios";
import { createServer } from "http";
import { WebSocketServer, WebSocket } from "ws";
import { createServer as createViteServer } from "vite";
import Database from "better-sqlite3";
import { nanoid } from "nanoid";
import path from "path";
import { existsSync, mkdirSync } from "fs";
import { fileURLToPath } from "url";
import bcrypt from "bcryptjs";
import pkg from "jsonwebtoken";
const { sign, verify } = pkg;

// JWT Configuration
const JWT_SECRET = process.env.JWT_SECRET || "lesson-master-secret-key-change-in-production";
const JWT_EXPIRES_IN = "7d";

// Helper functions for JWT
const generateToken = (userId: string): string => {
  return sign({ userId }, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN });
};

const verifyToken = (token: string): { userId: string } | null => {
  try {
    return verify(token, JWT_SECRET) as { userId: string };
  } catch {
    return null;
  }
};

const normalizeAnswerText = (value: string) => value.toLowerCase().trim().replace(/\s+/g, " ");

// Middleware to verify JWT from Authorization header
const authenticateToken = (req: express.Request, res: express.Response, next: express.NextFunction) => {
  const authHeader = req.headers.authorization;
  const token = authHeader?.split(' ')[1]; // Bearer TOKEN
  
  // Fallback to teacher-id header for backward compatibility
  const teacherId = req.headers["teacher-id"] as string;
  
  if (token) {
    const decoded = verifyToken(token);
    if (decoded) {
      (req as any).userId = decoded.userId;
      return next();
    }
  }
  
  if (teacherId) {
    (req as any).userId = teacherId;
    return next();
  }
  
  return res.status(401).json({ error: "Unauthorized - Invalid or missing token" });
};

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Database initialization with error handling
let db: any;
const dbFilePath = process.env.DATABASE_PATH || process.env.SQLITE_PATH || "presentations.db";

try {
  const dbDir = path.dirname(dbFilePath);
  if (dbDir && dbDir !== "." && !existsSync(dbDir)) {
    mkdirSync(dbDir, { recursive: true });
  }

  db = new Database(dbFilePath);
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA synchronous = NORMAL;");
  db.exec("PRAGMA busy_timeout = 5000;");
  console.log(`Database initialized successfully at: ${dbFilePath}`);
} catch (err) {
  console.error("Failed to initialize database:", err);
  process.exit(1);
}

// Initialize database
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    email TEXT UNIQUE NOT NULL,
    password TEXT NOT NULL,
    name TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS presentations (
    id TEXT PRIMARY KEY,
    teacher_id TEXT NOT NULL,
    title TEXT NOT NULL,
    theme TEXT DEFAULT 'light',
    globalBackgroundImage TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (teacher_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS reports (
    id TEXT PRIMARY KEY,
    teacher_id TEXT NOT NULL,
    presentation_id TEXT NOT NULL,
    presentation_title TEXT NOT NULL,
    data TEXT NOT NULL,
    privacy_mode INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (teacher_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (presentation_id) REFERENCES presentations(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS slides (
    id TEXT PRIMARY KEY,
    presentation_id TEXT NOT NULL,
    type TEXT NOT NULL,
    content TEXT NOT NULL,
    points INTEGER DEFAULT 0,
    "order" INTEGER NOT NULL,
    FOREIGN KEY (presentation_id) REFERENCES presentations(id) ON DELETE CASCADE
  );
`);

try {
  db.prepare("ALTER TABLE presentations ADD COLUMN teacher_id TEXT").run();
} catch (e) {}

try {
  db.prepare("ALTER TABLE reports ADD COLUMN teacher_id TEXT").run();
} catch (e) {}

try {
  db.prepare("ALTER TABLE slides ADD COLUMN points INTEGER DEFAULT 0").run();
} catch (e) {
  // Column already exists
}

try {
  db.prepare("ALTER TABLE reports ADD COLUMN privacy_mode INTEGER DEFAULT 0").run();
} catch (e) {}

// Cleanup old reports (older than 7 days)
const cleanupOldReports = () => {
  try {
    const result = db.prepare("DELETE FROM reports WHERE created_at < datetime('now', '-7 days')").run();
    if (result.changes > 0) {
      console.log(`Cleaned up ${result.changes} old reports.`);
    }
  } catch (e) {
    console.error("Failed to cleanup old reports", e);
  }
};

// Run cleanup on startup and then every 24 hours
cleanupOldReports();
setInterval(cleanupOldReports, 24 * 60 * 60 * 1000);

const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ server });

app.use(express.json());

// Rooms state
const rooms = new Map<string, {
  host: WebSocket;
  presentationId: string;
  currentSlideIndex: number;
  privacyMode: boolean;
  slides: any[];
  students: Map<string, { 
    ws: WebSocket | null; 
    connected: boolean;
    name: string; 
    avatarSeed: string;
    responses: Record<number, any>;
    score: number;
  }>;
  liveActivity: null | {
    id: string;
    type: 'poll' | 'wordcloud';
    question: string;
    options?: string[];
    responses: Record<string, string>;
  };
}>();

const getConnectedStudentsCount = (room: { students: Map<string, { connected: boolean }> }) =>
  Array.from(room.students.values()).filter((student) => student.connected).length;

const buildLiveActivityPayload = (activity: null | {
  id: string;
  type: 'poll' | 'wordcloud';
  question: string;
  options?: string[];
  responses: Record<string, string>;
}) => {
  if (!activity) return null;

  if (activity.type === 'poll') {
    const options = activity.options || [];
    const counts = options.map((option) => ({
      option,
      count: Object.values(activity.responses).filter((value) => value === option).length
    }));
    return {
      id: activity.id,
      type: activity.type,
      question: activity.question,
      options,
      counts,
      totalResponses: Object.keys(activity.responses).length
    };
  }

  const words = Object.values(activity.responses)
    .map((value) => String(value || '').trim().toLowerCase())
    .filter(Boolean);
  const countsMap: Record<string, number> = {};
  for (const word of words) countsMap[word] = (countsMap[word] || 0) + 1;
  const wordsCloud = Object.entries(countsMap)
    .map(([word, count]) => ({ word, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 40);

  return {
    id: activity.id,
    type: activity.type,
    question: activity.question,
    words: wordsCloud,
    totalResponses: Object.keys(activity.responses).length
  };
};

// Map presentationId to active PIN to allow reconnection
const presentationToPin = new Map<string, string>();

const loadSlidesForPresentation = (presentationId: string) => {
  return db.prepare("SELECT * FROM slides WHERE presentation_id = ? ORDER BY \"order\" ASC").all(presentationId);
};

const refreshRoomSlides = (presentationId: string) => {
  const slides = loadSlidesForPresentation(presentationId);
  for (const room of rooms.values()) {
    if (room.presentationId === presentationId) {
      room.slides = slides;
      if (room.currentSlideIndex >= slides.length) {
        room.currentSlideIndex = slides.length - 1;
      }
    }
  }
};

// API Routes
app.post("/api/auth/register", async (req, res) => {
  const { email, password, name } = req.body;
  
  if (!email || !password || !name) {
    return res.status(400).json({ error: "Email, password, and name are required" });
  }
  
  if (password.length < 6) {
    return res.status(400).json({ error: "Password must be at least 6 characters" });
  }
  
  const id = nanoid(10);
  try {
    // Hash password with bcrypt (cost factor 12)
    const hashedPassword = await bcrypt.hash(password, 12);
    db.prepare("INSERT INTO users (id, email, password, name) VALUES (?, ?, ?, ?)").run(id, email, hashedPassword, name);
    
    // Generate JWT token
    const token = generateToken(id);
    res.json({ id, email, name, token });
  } catch (err) {
    res.status(400).json({ error: "Email already exists" });
  }
});

app.post("/api/auth/login", async (req, res) => {
  const { email, password } = req.body;
  
  if (!email || !password) {
    return res.status(400).json({ error: "Email and password are required" });
  }
  
  const user: any = db.prepare("SELECT * FROM users WHERE email = ?").get(email);
  if (!user) {
    return res.status(401).json({ error: "Invalid credentials" });
  }
  
  // Check if password is hashed (bcrypt hashes start with $2)
  let isValidPassword = false;
  if (user.password.startsWith('$2')) {
    // Password is hashed - use bcrypt compare
    isValidPassword = await bcrypt.compare(password, user.password);
  } else {
    // Legacy plain text password - compare directly and migrate
    isValidPassword = user.password === password;
    if (isValidPassword) {
      // Migrate to hashed password
      const hashedPassword = await bcrypt.hash(password, 12);
      db.prepare("UPDATE users SET password = ? WHERE id = ?").run(hashedPassword, user.id);
      console.log(`Migrated password for user ${user.email} to bcrypt hash`);
    }
  }
  
  if (!isValidPassword) {
    return res.status(401).json({ error: "Invalid credentials" });
  }
  
  // Generate JWT token
  const token = generateToken(user.id);
  res.json({ id: user.id, email: user.email, name: user.name, token });
});

// Google OAuth
app.get("/api/auth/google/url", (req, res) => {
  const rootUrl = "https://accounts.google.com/o/oauth2/v2/auth";
  const options = {
    redirect_uri: `${process.env.APP_URL}/api/auth/google/callback`,
    client_id: process.env.GOOGLE_CLIENT_ID!,
    access_type: "offline",
    response_type: "code",
    prompt: "consent",
    scope: [
      "https://www.googleapis.com/auth/userinfo.profile",
      "https://www.googleapis.com/auth/userinfo.email",
    ].join(" "),
  };

  const qs = new URLSearchParams(options);
  res.json({ url: `${rootUrl}?${qs.toString()}` });
});

app.get("/api/auth/google/callback", async (req, res) => {
  const code = req.query.code as string;
  const redirectUri = `${process.env.APP_URL}/api/auth/google/callback`;

  try {
    // Exchange code for tokens
    const { data } = await axios.post("https://oauth2.googleapis.com/token", {
      code,
      client_id: process.env.GOOGLE_CLIENT_ID,
      client_secret: process.env.GOOGLE_CLIENT_SECRET,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
    });

    const { access_token } = data;

    // Get user info
    const { data: googleUser } = await axios.get(
      `https://www.googleapis.com/oauth2/v1/userinfo?alt=json&access_token=${access_token}`,
      {
        headers: {
          Authorization: `Bearer ${access_token}`,
        },
      }
    );

    // Find or create user
    let user: any = db.prepare("SELECT * FROM users WHERE email = ?").get(googleUser.email);
    if (!user) {
      const id = nanoid(10);
      // Hash a random password for Google OAuth users
      const randomPassword = nanoid(32);
      const hashedPassword = await bcrypt.hash(randomPassword, 12);
      db.prepare("INSERT INTO users (id, email, password, name) VALUES (?, ?, ?, ?)").run(
        id,
        googleUser.email,
        hashedPassword,
        googleUser.name
      );
      user = { id, email: googleUser.email, name: googleUser.name };
    }

    // Generate JWT token
    const token = generateToken(user.id);

    // Send success message and close popup
    res.send(`
      <html>
        <body>
          <script>
            if (window.opener) {
              window.opener.postMessage({ 
                type: 'OAUTH_AUTH_SUCCESS', 
                user: ${JSON.stringify({ id: user.id, email: user.email, name: user.name })},
                token: "${token}"
              }, '*');
              window.close();
            } else {
              window.location.href = '/';
            }
          </script>
          <p>Authentication successful. This window should close automatically.</p>
        </body>
      </html>
    `);
  } catch (err) {
    console.error("Google Auth Error:", err);
    res.status(500).send("Authentication failed");
  }
});

// Debug route to check registrations
app.get("/api/debug/check-email", (req, res) => {
  const email = req.query.email;
  if (!email) return res.status(400).json({ error: "Email required" });
  const users = db.prepare("SELECT id, email, name, created_at FROM users WHERE email = ?").all(email);
  res.json({ count: users.length, users });
});

// Helper to ensure teacher exists in SQLite (fallback for session mismatch)
const ensureTeacher = async (id: string, name: string = "Учител") => {
  const user = db.prepare("SELECT id FROM users WHERE id = ?").get(id);
  if (!user) {
    console.log("Auto-creating user record for sync:", id);
    const hashedPassword = await bcrypt.hash(nanoid(32), 12);
    db.prepare("INSERT OR IGNORE INTO users (id, email, password, name) VALUES (?, ?, ?, ?)").run(
      id, 
      `${id}@internal.system`, 
      hashedPassword, 
      name
    );
  }
};

app.get("/api/presentations", authenticateToken, async (req, res) => {
  const teacherId = (req as any).userId;
  await ensureTeacher(teacherId);
  const rows = db.prepare("SELECT * FROM presentations WHERE teacher_id = ? ORDER BY created_at DESC").all(teacherId);
  res.json(rows);
});

app.post("/api/presentations", authenticateToken, async (req, res) => {
  const teacherId = (req as any).userId;
  await ensureTeacher(teacherId);
  const { title, slides, theme, globalBackgroundImage } = req.body;
  const id = nanoid(10);
  
  try {
    const transaction = db.transaction(() => {
      db.prepare("INSERT INTO presentations (id, teacher_id, title, theme, globalBackgroundImage) VALUES (?, ?, ?, ?, ?)")
        .run(id, teacherId, title || 'Нова презентация', theme || 'light', globalBackgroundImage || null);
      
      if (slides && Array.isArray(slides)) {
        const insertSlide = db.prepare("INSERT INTO slides (id, presentation_id, type, content, points, \"order\") VALUES (?, ?, ?, ?, ?, ?)");
        slides.forEach((slide: any, index: number) => {
          insertSlide.run(nanoid(10), id, slide.type, JSON.stringify(slide.content), slide.points || 0, index);
        });
      } else {
        // Add a default first slide if none provided
        const defaultContent = JSON.stringify({
          title: "Добре дошли в новия урок!",
          text: "Това е вашият първи слайд. Можете да го редактирате оттук.",
          backgroundColor: "#ffffff",
          titleColor: "#1e293b",
          titleSize: 40
        });
        db.prepare("INSERT INTO slides (id, presentation_id, type, content, points, \"order\") VALUES (?, ?, ?, ?, ?, ?)")
          .run(nanoid(10), id, "text-image", defaultContent, 0, 0);
      }
    });

    transaction();
    res.json({ id, title });
  } catch (error: any) {
    console.error("Failed to create presentation:", error);
    res.status(500).json({ error: "Failed to create presentation" });
  }
});

app.get("/api/presentations/:id", authenticateToken, (req, res) => {
  const teacherId = (req as any).userId;
  const presentation = db.prepare("SELECT * FROM presentations WHERE id = ?").get(req.params.id);
  if (!presentation) return res.status(404).json({ error: "Not found" });
  
  // Allow students to view presentation if they have the PIN, but for editor/host we check teacherId
  // In a real app we'd have more granular checks.
  
  const slides = db.prepare("SELECT * FROM slides WHERE presentation_id = ? ORDER BY \"order\" ASC").all(req.params.id);
  res.json({ ...presentation, slides: slides.map((s: any) => ({ ...s, content: JSON.parse(s.content) })) });
});

app.put("/api/presentations/:id", authenticateToken, (req, res) => {
  const teacherId = (req as any).userId;
  
  const { title, slides, theme, globalBackgroundImage } = req.body;
  
  if (!slides || !Array.isArray(slides)) {
    return res.status(400).json({ error: "Slides are required and must be an array" });
  }

  try {
    const transaction = db.transaction(() => {
      const updateResult = db.prepare("UPDATE presentations SET title = ?, theme = ?, globalBackgroundImage = ? WHERE id = ? AND teacher_id = ?")
        .run(title, theme || 'light', globalBackgroundImage || null, req.params.id, teacherId);
      
      if (updateResult.changes === 0) {
        throw new Error("Presentation not found or unauthorized");
      }
      
      // Simple sync: delete all and re-insert
      db.prepare("DELETE FROM slides WHERE presentation_id = ?").run(req.params.id);
      const insertSlide = db.prepare("INSERT INTO slides (id, presentation_id, type, content, points, \"order\") VALUES (?, ?, ?, ?, ?, ?)");
      
      slides.forEach((slide: any, index: number) => {
        insertSlide.run(nanoid(10), req.params.id, slide.type, JSON.stringify(slide.content), slide.points || 0, index);
      });
    });

    transaction();
    refreshRoomSlides(req.params.id);
    res.json({ success: true });
  } catch (error: any) {
    console.error("Failed to update presentation:", error);
    res.status(error.message === "Presentation not found or unauthorized" ? 403 : 500)
      .json({ error: error.message || "Failed to update presentation" });
  }
});

app.delete("/api/presentations/:id", authenticateToken, (req, res) => {
  const teacherId = (req as any).userId;
  db.prepare("DELETE FROM presentations WHERE id = ? AND teacher_id = ?").run(req.params.id, teacherId);
  res.json({ success: true });
});

app.get("/api/reports", authenticateToken, async (req, res) => {
  const teacherId = (req as any).userId;
  await ensureTeacher(teacherId);
  const rows = db.prepare("SELECT * FROM reports WHERE teacher_id = ? ORDER BY created_at DESC").all(teacherId);
  res.json(rows.map((r: any) => ({ ...r, createdAt: r.created_at, data: JSON.parse(r.data) })));
});

app.get("/api/reports/:id", authenticateToken, async (req, res) => {
  const teacherId = (req as any).userId;
  await ensureTeacher(teacherId);
  const row = db.prepare("SELECT * FROM reports WHERE id = ? AND teacher_id = ?").get(req.params.id, teacherId);
  if (!row) return res.status(404).json({ error: "Report not found" });
  res.json({ ...row, createdAt: (row as any).created_at, data: JSON.parse((row as any).data) });
});

app.post("/api/reports", authenticateToken, async (req, res) => {
  const teacherId = (req as any).userId;
  await ensureTeacher(teacherId);
  const { presentationId, presentationTitle, data, privacyMode } = req.body;
  const id = nanoid(10);
  
  // If privacy mode is on, anonymize student names in the data
  let finalData = data;
  if (privacyMode) {
    const anonymizedStudents = data.students.map((s: any, idx: number) => ({
      ...s,
      name: `Ученик ${idx + 1}`
    }));
    finalData = { ...data, students: anonymizedStudents };
  }

  // Check if presentation exists, if not, we still save the report but without FK constraint issues
  const presentationExists = db.prepare("SELECT id FROM presentations WHERE id = ?").get(presentationId);
  const finalPresentationId = presentationExists ? presentationId : 'deleted';

  // If it doesn't exist and we haven't created the 'deleted' placeholder, do it once
  if (!presentationExists) {
    const placeholder = db.prepare("SELECT id FROM presentations WHERE id = 'deleted'").get();
    if (!placeholder) {
      db.prepare("INSERT INTO presentations (id, teacher_id, title) VALUES ('deleted', ?, 'Изтрит урок')").run(teacherId);
    }
  }

  db.prepare("INSERT INTO reports (id, teacher_id, presentation_id, presentation_title, data, privacy_mode) VALUES (?, ?, ?, ?, ?, ?)")
    .run(id, teacherId, finalPresentationId, presentationTitle, JSON.stringify(finalData), privacyMode ? 1 : 0);
  res.json({ id });
});

app.post("/api/user/purge", authenticateToken, (req, res) => {
  const teacherId = (req as any).userId;
  
  try {
    db.transaction(() => {
      db.prepare("DELETE FROM reports WHERE teacher_id = ?").run(teacherId);
      db.prepare("DELETE FROM presentations WHERE teacher_id = ?").run(teacherId);
    })();
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: "Purge failed" });
  }
});

app.delete("/api/reports/:id", authenticateToken, (req, res) => {
  const teacherId = (req as any).userId;
  db.prepare("DELETE FROM reports WHERE id = ? AND teacher_id = ?").run(req.params.id, teacherId);
  res.json({ success: true });
});

app.get("/api/config", (req, res) => {
  res.json({
    geminiApiKey: process.env.GEMINI_API_KEY || process.env.API_KEY || ""
  });
});

app.get("/env.js", (req, res) => {
  const runtimeConfig = {
    VITE_FIREBASE_API_KEY: process.env.VITE_FIREBASE_API_KEY || "",
    VITE_FIREBASE_AUTH_DOMAIN: process.env.VITE_FIREBASE_AUTH_DOMAIN || "",
    VITE_FIREBASE_PROJECT_ID: process.env.VITE_FIREBASE_PROJECT_ID || "",
    VITE_FIREBASE_STORAGE_BUCKET: process.env.VITE_FIREBASE_STORAGE_BUCKET || "",
    VITE_FIREBASE_MESSAGING_SENDER_ID: process.env.VITE_FIREBASE_MESSAGING_SENDER_ID || "",
    VITE_FIREBASE_APP_ID: process.env.VITE_FIREBASE_APP_ID || ""
  };

  res.type("application/javascript");
  res.send(`window.__RUNTIME_CONFIG__ = ${JSON.stringify(runtimeConfig)};`);
});

// Health check endpoint for Railway - MUST be before static file serving
app.get("/health", (req, res) => {
  res.status(200).json({ status: "ok", timestamp: new Date().toISOString() });
});

app.get("/api/health", (req, res) => {
  res.status(200).json({ status: "ok", timestamp: new Date().toISOString() });
});

// WebSocket Logic
wss.on("connection", (ws) => {
  let currentRoomPin: string | null = null;
  let studentId: string | null = null;

  ws.on("message", (data) => {
    try {
      const message = JSON.parse(data.toString());

      switch (message.type) {
        case "HOST_START": {
          let pin = null;
          
          // 1. Find if there's an existing room for this presentation
          for (const [p, r] of rooms.entries()) {
            if (r.presentationId === message.presentationId) {
              pin = p;
              r.host = ws; // Update to the newest WebSocket connection
              break;
            }
          }

          // 2. If no room exists, create a new one
          if (!pin) {
            pin = Math.floor(100000 + Math.random() * 900000).toString();
            rooms.set(pin, {
              host: ws,
              presentationId: message.presentationId,
              currentSlideIndex: -1,
              privacyMode: false,
              slides: loadSlidesForPresentation(message.presentationId),
              students: new Map(),
              liveActivity: null
            });
          }
          
          currentRoomPin = pin;
          const room = rooms.get(pin);
          if (!room) break;
          
          // 3. Always send the current state back to the host
          room.slides = loadSlidesForPresentation(room.presentationId);
          const currentSlide = room.slides[room.currentSlideIndex];
          
          ws.send(JSON.stringify({ 
            type: "ROOM_CREATED", 
            pin,
            students: Array.from(room.students.entries())
              .filter(([, student]) => student.connected)
              .map(([id, student]) => ({ 
                id,
                name: student.name,
                avatarSeed: student.avatarSeed
              })),
            currentSlide: currentSlide ? {
              ...currentSlide,
              content: JSON.parse(currentSlide.content)
            } : null,
            currentSlideIndex: room.currentSlideIndex,
            liveActivity: buildLiveActivityPayload(room.liveActivity)
          }));
          break;
        }

        case "JOIN_ROOM": {
          const room = rooms.get(message.pin);
          if (room) {
            const normalizedName = String(message.name || '').trim();
            const reconnectEntry = normalizedName
              ? Array.from(room.students.entries()).find(([, student]) => !student.connected && student.name === normalizedName)
              : null;

            if (reconnectEntry) {
              studentId = reconnectEntry[0];
              const existing = reconnectEntry[1];
              existing.ws = ws;
              existing.connected = true;
            } else {
              studentId = nanoid(5);
              const avatarSeed = Math.random().toString(36).substring(7);
              room.students.set(studentId, { ws, connected: true, name: message.name, avatarSeed, responses: {}, score: 0 });
            }

            const currentStudent = room.students.get(studentId)!;
            currentRoomPin = message.pin;

            ws.send(JSON.stringify({ 
              type: "JOIN_SUCCESS", 
              studentId,
              avatarSeed: currentStudent.avatarSeed,
              presentation: {
                id: room.presentationId,
                globalBackgroundImage: db.prepare("SELECT globalBackgroundImage FROM presentations WHERE id = ?").get(room.presentationId)?.globalBackgroundImage
              }
            }));
            
            // Notify host
            if (room.host.readyState === WebSocket.OPEN) {
              room.host.send(JSON.stringify({ 
                type: "STUDENT_JOINED", 
                id: studentId, 
                name: currentStudent.name,
                avatarSeed: currentStudent.avatarSeed,
                count: getConnectedStudentsCount(room)
              }));
            }

            // Send current slide state to student
            const currentSlide = room.currentSlideIndex >= 0 ? room.slides[room.currentSlideIndex] : null;
            ws.send(JSON.stringify({ 
              type: "SLIDE_UPDATE", 
              index: room.currentSlideIndex,
              slide: currentSlide
                ? { ...currentSlide, content: JSON.parse(currentSlide.content) }
                : null
            }));

            if (room.liveActivity && ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify({
                type: "LIVE_ACTIVITY_START",
                activity: {
                  id: room.liveActivity.id,
                  type: room.liveActivity.type,
                  question: room.liveActivity.question,
                  options: room.liveActivity.options || []
                }
              }));
            }
          } else {
            ws.send(JSON.stringify({ type: "ERROR", message: "Invalid PIN" }));
          }
          break;
        }

        case "START_PRESENTATION":
        case "NEXT_SLIDE": {
          let pin = currentRoomPin || message.pin;
          
          // Fallback: if we don't have a pin but we have a presentationId, find the room
          if (!pin && message.presentationId) {
            for (const [p, r] of rooms.entries()) {
              if (r.presentationId === message.presentationId) {
                pin = p;
                break;
              }
            }
          }

          if (!pin) {
            ws.send(JSON.stringify({ type: "ERROR", message: "Session not found. Please refresh." }));
            break;
          }

          const room = rooms.get(pin);
          
          if (room && room.host === ws) {
            currentRoomPin = pin; // Ensure it's set for future messages
            if (message.type === "START_PRESENTATION") {
              room.currentSlideIndex = 0;
              room.privacyMode = !!message.privacyMode;
            } else {
              room.currentSlideIndex++;
            }
            
            const slides = room.slides;
            
            if (slides.length === 0) {
              ws.send(JSON.stringify({ type: "ERROR", message: "Презентацията няма слайдове. Моля добавете слайдове и ги запазете." }));
              break;
            }

            const nextSlide = slides[room.currentSlideIndex];
            
            if (!nextSlide && room.currentSlideIndex >= slides.length) {
              // End of presentation
              const leaderboard = Array.from(room.students.values())
                .map((s, idx) => ({ 
                  name: room.privacyMode ? `Ученик ${idx + 1}` : s.name, 
                  score: s.score, 
                  avatarSeed: s.avatarSeed 
                }))
                .sort((a, b) => b.score - a.score);

              const finalUpdate = {
                type: "PRESENTATION_FINISHED",
                leaderboard: leaderboard,
                privacyMode: room.privacyMode
              };
              if (room.host.readyState === WebSocket.OPEN) {
                room.host.send(JSON.stringify(finalUpdate));
              }
              room.students.forEach(s => {
                if (s.ws?.readyState === WebSocket.OPEN) {
                  s.ws.send(JSON.stringify({ ...finalUpdate, yourScore: s.score }));
                }
              });
              break;
            }

            const update = { 
              type: "SLIDE_UPDATE", 
              index: room.currentSlideIndex,
              slide: nextSlide ? { ...nextSlide, content: JSON.parse(nextSlide.content) } : null
            };

            if (room.host.readyState === WebSocket.OPEN) {
              room.host.send(JSON.stringify(update));
            }
            room.students.forEach(s => {
              if (s.ws?.readyState === WebSocket.OPEN) {
                s.ws.send(JSON.stringify(update));
              }
            });
          }
          break;
        }

        case "TOGGLE_LEADERBOARD": {
          if (!currentRoomPin) break;
          const room = rooms.get(currentRoomPin);
          if (room && room.host === ws) {
            const leaderboard = Array.from(room.students.values())
              .map(s => ({ name: s.name, score: s.score, avatarSeed: s.avatarSeed }))
              .sort((a, b) => b.score - a.score);
            
            room.students.forEach(s => {
              if (s.ws?.readyState === WebSocket.OPEN) {
                s.ws.send(JSON.stringify({ 
                  type: "SHOW_LEADERBOARD", 
                  show: message.show,
                  yourScore: s.score,
                  leaderboard: leaderboard.slice(0, 5)
                }));
              }
            });
          }
          break;
        }

        case "HOST_START_ACTIVITY": {
          if (!currentRoomPin) break;
          const room = rooms.get(currentRoomPin);
          if (!room || room.host !== ws) break;

          const activityType = message.activityType === 'poll' ? 'poll' : 'wordcloud';
          const question = String(message.question || '').trim();
          if (!question) {
            ws.send(JSON.stringify({ type: 'ERROR', message: 'Въведете въпрос за live активността.' }));
            break;
          }

          const options = activityType === 'poll'
            ? (Array.isArray(message.options) ? message.options : [])
                .map((value: any) => String(value || '').trim())
                .filter(Boolean)
                .slice(0, 8)
            : undefined;

          if (activityType === 'poll' && (!options || options.length < 2)) {
            ws.send(JSON.stringify({ type: 'ERROR', message: 'Анкетата изисква поне 2 опции.' }));
            break;
          }

          room.liveActivity = {
            id: nanoid(8),
            type: activityType,
            question,
            options,
            responses: {}
          };

          const hostUpdate = buildLiveActivityPayload(room.liveActivity);
          if (room.host.readyState === WebSocket.OPEN) {
            room.host.send(JSON.stringify({ type: 'LIVE_ACTIVITY_UPDATE', activity: hostUpdate }));
          }
          room.students.forEach((student) => {
            if (student.ws?.readyState === WebSocket.OPEN) {
              student.ws.send(JSON.stringify({
                type: 'LIVE_ACTIVITY_START',
                activity: {
                  id: room.liveActivity?.id,
                  type: room.liveActivity?.type,
                  question: room.liveActivity?.question,
                  options: room.liveActivity?.options || []
                }
              }));
            }
          });
          break;
        }

        case "HOST_END_ACTIVITY": {
          if (!currentRoomPin) break;
          const room = rooms.get(currentRoomPin);
          if (!room || room.host !== ws) break;
          room.liveActivity = null;

          if (room.host.readyState === WebSocket.OPEN) {
            room.host.send(JSON.stringify({ type: 'LIVE_ACTIVITY_END' }));
          }
          room.students.forEach((student) => {
            if (student.ws?.readyState === WebSocket.OPEN) {
              student.ws.send(JSON.stringify({ type: 'LIVE_ACTIVITY_END' }));
            }
          });
          break;
        }

        case "STUDENT_ACTIVITY_RESPONSE": {
          if (!currentRoomPin) break;
          const room = rooms.get(currentRoomPin);
          if (!room || !studentId || !room.liveActivity) break;
          const student = room.students.get(studentId);
          if (!student) break;

          if (message.activityId && message.activityId !== room.liveActivity.id) break;

          const normalizedResponse = String(message.response || '').trim();
          if (!normalizedResponse) break;

          room.liveActivity.responses[studentId] = normalizedResponse;

          if (student.ws?.readyState === WebSocket.OPEN) {
            student.ws.send(JSON.stringify({ type: 'LIVE_ACTIVITY_ACK' }));
          }

          const hostUpdate = buildLiveActivityPayload(room.liveActivity);
          if (room.host.readyState === WebSocket.OPEN) {
            room.host.send(JSON.stringify({ type: 'LIVE_ACTIVITY_UPDATE', activity: hostUpdate }));
          }
          break;
        }

        case "SUBMIT_RESPONSE": {
          if (!currentRoomPin) break;
          const room = rooms.get(currentRoomPin);
          if (room && studentId) {
            const student = room.students.get(studentId);
            if (student) {
              student.responses[room.currentSlideIndex] = message.response;
              
              // Score calculation
              const currentSlide = room.slides[room.currentSlideIndex];
              if (currentSlide) {
                const content = JSON.parse(currentSlide.content);
                const slidePoints = currentSlide.points ?? 1;
                let isCorrect = false;
                let isGraded = true;

                if (currentSlide.type === 'quiz-single' || currentSlide.type === 'boolean') {
                  const correctIdx = content.options.findIndex((o: any) => o.isCorrect);
                  if (message.response === correctIdx) {
                    isCorrect = true;
                  }
                } else if (currentSlide.type === 'quiz-multi') {
                  const correctIndices = content.options.map((o: any, i: number) => o.isCorrect ? i : -1).filter((i: number) => i !== -1);
                  isCorrect = Array.isArray(message.response) && 
                            message.response.length === correctIndices.length &&
                            message.response.every(r => correctIndices.includes(r));
                } else if (currentSlide.type === 'hotspot') {
                  const hotspot = content.hotspot;
                  const response = message.response;
                  if (hotspot && response) {
                    const dist = Math.sqrt(Math.pow(response.x - hotspot.x, 2) + Math.pow(response.y - hotspot.y, 2));
                    if (dist <= hotspot.radius) {
                      isCorrect = true;
                    }
                  }
                } else if (currentSlide.type === 'labeling') {
                  const labels = content.labels || [];
                  const studentPositions = message.response || {};
                  let correctCount = 0;
                  labels.forEach((l: any) => {
                    const sPos = studentPositions[l.id];
                    if (sPos) {
                      const dist = Math.sqrt(Math.pow(sPos.x - l.x, 2) + Math.pow(sPos.y - l.y, 2));
                      if (dist < 14) { // 14% tolerance for easier label placement
                        correctCount++;
                      }
                    }
                  });
                  if (labels.length > 0 && correctCount === labels.length) {
                    isCorrect = true;
                  }
                } else if (currentSlide.type === 'matching') {
                  const pairs = content.pairs || [];
                  const studentConnections = message.response || {};
                  let correctCount = 0;
                  pairs.forEach((p: any) => {
                    if (studentConnections[p.id] === p.id) {
                      correctCount++;
                    }
                  });
                  if (pairs.length > 0 && correctCount === pairs.length) {
                    isCorrect = true;
                  }
                } else if (currentSlide.type === 'ordering') {
                  const items = content.orderingItems || [];
                  const responseOrder = Array.isArray(message.response) ? message.response : [];
                  if (items.length > 0 && responseOrder.length === items.length) {
                    isCorrect = items.every((item: any, idx: number) => responseOrder[idx] === item.id);
                  }
                } else if (currentSlide.type === 'categorization') {
                  const items = content.categoryItems || [];
                  const responseMap = message.response || {};
                  if (items.length > 0) {
                    isCorrect = items.every((item: any) => responseMap[item.id] === item.category);
                  }
                } else if (currentSlide.type === 'open-question') {
                  const expectedRaw = String(content.expectedAnswer || '').trim();
                  const learnerRaw = typeof message.response === 'string' ? message.response : String(message.response || '');

                  if (!expectedRaw) {
                    isGraded = false;
                  } else {
                    const expectedAnswers = expectedRaw
                      .split(/\r?\n|\|/)
                      .map((answer: string) => normalizeAnswerText(answer))
                      .filter(Boolean);
                    const learnerAnswer = normalizeAnswerText(learnerRaw);
                    isCorrect = learnerAnswer.length > 0 && expectedAnswers.includes(learnerAnswer);
                  }
                } else if (currentSlide.type === 'free-response' || currentSlide.type === 'whiteboard') {
                  isGraded = false;
                }

                if (isGraded && isCorrect) {
                  student.score += slidePoints;
                }

                // Send feedback to student
                if (ws.readyState === WebSocket.OPEN) {
                  ws.send(JSON.stringify({
                    type: "FEEDBACK",
                    isCorrect: isGraded ? isCorrect : null,
                    pointsEarned: (isGraded && isCorrect) ? slidePoints : 0,
                    totalScore: student.score,
                    message: isGraded ? undefined : "Този отговор е без автоматично точкуване."
                  }));
                }
              }

              const update = {
                type: "RESPONSE_RECEIVED",
                id: studentId,
                response: message.response,
                slideIndex: room.currentSlideIndex,
                score: student.score,
                leaderboard: Array.from(room.students.values())
                  .map(s => ({ name: s.name, score: s.score, avatarSeed: s.avatarSeed }))
                  .sort((a, b) => b.score - a.score)
                  .slice(0, 5)
              };

              if (room.host.readyState === WebSocket.OPEN) {
                room.host.send(JSON.stringify(update));
              }
            }
          }
          break;
        }
      }
    } catch (err) {
      console.error("WebSocket message error:", err);
    }
  });

  ws.on("close", () => {
    if (currentRoomPin) {
      const room = rooms.get(currentRoomPin);
      if (room) {
        if (room.host === ws) {
          // Notify students and close room
          room.students.forEach(s => {
            if (s.ws?.readyState === WebSocket.OPEN) {
              s.ws.send(JSON.stringify({ type: "ROOM_CLOSED" }));
            }
          });
          rooms.delete(currentRoomPin);
        } else if (studentId) {
          const student = room.students.get(studentId);
          if (student) {
            student.connected = false;
            student.ws = null;
          }
          if (room.host.readyState === WebSocket.OPEN) {
            room.host.send(JSON.stringify({ 
              type: "STUDENT_LEFT", 
              id: studentId,
              count: getConnectedStudentsCount(room) 
            }));
          }
        }
      }
    }
  });
});

app.get("/api/sessions/:pin/report", (req, res) => {
  const room = rooms.get(req.params.pin);
  if (!room) return res.status(404).json({ error: "Session not found" });

  const presentation = db.prepare("SELECT * FROM presentations WHERE id = ?").get(room.presentationId);
  const slides = db.prepare("SELECT * FROM slides WHERE presentation_id = ? ORDER BY \"order\" ASC").all(room.presentationId);
  const ephemeralOnlySlides = new Set(["whiteboard"]);

  const reportData = {
    presentationTitle: presentation.title,
    date: new Date().toLocaleDateString("bg-BG"),
    students: Array.from(room.students.values()).map(s => ({
      name: s.name,
      score: s.score,
      responses: Object.fromEntries(
        Object.entries(s.responses).filter(([slideIndex]) => {
          const idx = Number(slideIndex);
          const slide = slides[idx];
          if (!slide) return true;
          return !ephemeralOnlySlides.has(slide.type);
        })
      )
    })),
    slides: slides.map(s => ({
      type: s.type,
      content: JSON.parse(s.content)
    }))
  };

  res.json(reportData);
});

// In production, serve static files. In development, use Vite middleware.
const startServer = async () => {
  console.log(`Starting server in ${process.env.NODE_ENV || 'development'} mode`);
  console.log(`__dirname: ${__dirname}`);
  
  const distPath = path.join(__dirname, "dist");
  const hasBuiltClient = existsSync(path.join(distPath, "index.html"));

  if (process.env.NODE_ENV !== "production" || !hasBuiltClient) {
    if (process.env.NODE_ENV === "production" && !hasBuiltClient) {
      console.warn(`dist/index.html not found at ${distPath}. Falling back to Vite middleware.`);
    } else {
      console.log("Loading Vite dev server...");
    }

    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
    console.log("Vite middleware loaded");
  } else {
    // Serve built static files in production
    console.log(`Serving static files from: ${distPath}`);
    app.use(express.static(distPath));
    app.get("*", (req, res, next) => {
      // Skip API and WebSocket routes
      if (req.path.startsWith('/api') || req.path === '/health') {
        return next();
      }
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  const PORT = Number(process.env.PORT) || 3000;
  server.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on port ${PORT}`);
    console.log(`Health check: http://localhost:${PORT}/health`);
  });
};


const shutdown = (signal: string) => {
  console.log(`Received ${signal}. Shutting down gracefully...`);

  wss.clients.forEach(client => {
    try { client.close(); } catch {}
  });

  server.close(() => {
    try {
      db.close();
      console.log('Database connection closed');
    } catch (err) {
      console.error('Error while closing database:', err);
    }
    process.exit(0);
  });

  // Force exit if graceful shutdown takes too long
  setTimeout(() => process.exit(0), 5000).unref();
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

startServer().catch(err => {
  console.error("Failed to start server:", err);
  process.exit(1);
});

import express from "express";
import axios from "axios";
import { createServer } from "http";
import { WebSocketServer, WebSocket } from "ws";
import { createServer as createViteServer } from "vite";
import Database from "better-sqlite3";
import { nanoid } from "nanoid";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const db = new Database("presentations.db");

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

// Cleanup old reports (older than 3 days)
const cleanupOldReports = () => {
  try {
    const result = db.prepare("DELETE FROM reports WHERE created_at < datetime('now', '-3 days')").run();
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
  students: Map<string, { 
    ws: WebSocket; 
    name: string; 
    avatarSeed: string;
    responses: Record<number, any>;
    score: number;
  }>;
}>();

// Map presentationId to active PIN to allow reconnection
const presentationToPin = new Map<string, string>();

// API Routes
app.post("/api/auth/register", (req, res) => {
  const { email, password, name } = req.body;
  const id = nanoid(10);
  try {
    db.prepare("INSERT INTO users (id, email, password, name) VALUES (?, ?, ?, ?)").run(id, email, password, name);
    res.json({ id, email, name });
  } catch (err) {
    res.status(400).json({ error: "Email already exists" });
  }
});

app.post("/api/auth/login", (req, res) => {
  const { email, password } = req.body;
  const user = db.prepare("SELECT * FROM users WHERE email = ? AND password = ?").get(email, password);
  if (!user) return res.status(401).json({ error: "Invalid credentials" });
  res.json({ id: user.id, email: user.email, name: user.name });
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
    let user = db.prepare("SELECT * FROM users WHERE email = ?").get(googleUser.email);
    if (!user) {
      const id = nanoid(10);
      db.prepare("INSERT INTO users (id, email, password, name) VALUES (?, ?, ?, ?)").run(
        id,
        googleUser.email,
        "google-auth", // placeholder password
        googleUser.name
      );
      user = { id, email: googleUser.email, name: googleUser.name };
    }

    // Send success message and close popup
    res.send(`
      <html>
        <body>
          <script>
            if (window.opener) {
              window.opener.postMessage({ 
                type: 'OAUTH_AUTH_SUCCESS', 
                user: ${JSON.stringify({ id: user.id, email: user.email, name: user.name })} 
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

app.get("/api/presentations", (req, res) => {
  const teacherId = req.headers["teacher-id"];
  if (!teacherId) return res.status(401).json({ error: "Unauthorized" });
  const rows = db.prepare("SELECT * FROM presentations WHERE teacher_id = ? ORDER BY created_at DESC").all(teacherId);
  res.json(rows);
});

app.post("/api/presentations", (req, res) => {
  const teacherId = req.headers["teacher-id"];
  if (!teacherId) return res.status(401).json({ error: "Unauthorized" });
  const { title } = req.body;
  const id = nanoid(10);
  db.prepare("INSERT INTO presentations (id, teacher_id, title) VALUES (?, ?, ?)").run(id, teacherId, title);
  
  // Add a default first slide
  const defaultContent = JSON.stringify({
    title: "Добре дошли в новия урок!",
    text: "Това е вашият първи слайд. Можете да го редактирате оттук.",
    backgroundColor: "#ffffff",
    titleColor: "#1e293b",
    titleSize: 40
  });
  db.prepare("INSERT INTO slides (id, presentation_id, type, content, points, \"order\") VALUES (?, ?, ?, ?, ?, ?)")
    .run(nanoid(10), id, "text-image", defaultContent, 0, 0);

  res.json({ id, title });
});

app.get("/api/presentations/:id", (req, res) => {
  const teacherId = req.headers["teacher-id"];
  const presentation = db.prepare("SELECT * FROM presentations WHERE id = ?").get(req.params.id);
  if (!presentation) return res.status(404).json({ error: "Not found" });
  
  // Allow students to view presentation if they have the PIN, but for editor/host we check teacherId
  // In a real app we'd have more granular checks.
  
  const slides = db.prepare("SELECT * FROM slides WHERE presentation_id = ? ORDER BY \"order\" ASC").all(req.params.id);
  res.json({ ...presentation, slides: slides.map((s: any) => ({ ...s, content: JSON.parse(s.content) })) });
});

app.put("/api/presentations/:id", (req, res) => {
  const teacherId = req.headers["teacher-id"];
  if (!teacherId) return res.status(401).json({ error: "Unauthorized" });
  
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
    res.json({ success: true });
  } catch (error: any) {
    console.error("Failed to update presentation:", error);
    res.status(error.message === "Presentation not found or unauthorized" ? 403 : 500)
      .json({ error: error.message || "Failed to update presentation" });
  }
});

app.delete("/api/presentations/:id", (req, res) => {
  const teacherId = req.headers["teacher-id"];
  if (!teacherId) return res.status(401).json({ error: "Unauthorized" });
  db.prepare("DELETE FROM presentations WHERE id = ? AND teacher_id = ?").run(req.params.id, teacherId);
  res.json({ success: true });
});

app.get("/api/reports", (req, res) => {
  const teacherId = req.headers["teacher-id"];
  if (!teacherId) return res.status(401).json({ error: "Unauthorized" });
  const rows = db.prepare("SELECT * FROM reports WHERE teacher_id = ? ORDER BY created_at DESC").all(teacherId);
  res.json(rows.map((r: any) => ({ ...r, data: JSON.parse(r.data) })));
});

app.get("/api/reports/:id", (req, res) => {
  const teacherId = req.headers["teacher-id"];
  if (!teacherId) return res.status(401).json({ error: "Unauthorized" });
  const row = db.prepare("SELECT * FROM reports WHERE id = ? AND teacher_id = ?").get(req.params.id, teacherId);
  if (!row) return res.status(404).json({ error: "Report not found" });
  res.json({ ...row, data: JSON.parse(row.data) });
});

app.post("/api/reports", (req, res) => {
  const teacherId = req.headers["teacher-id"];
  if (!teacherId) return res.status(401).json({ error: "Unauthorized" });
  const { presentationId, presentationTitle, data } = req.body;
  const id = nanoid(10);
  db.prepare("INSERT INTO reports (id, teacher_id, presentation_id, presentation_title, data) VALUES (?, ?, ?, ?, ?)")
    .run(id, teacherId, presentationId, presentationTitle, JSON.stringify(data));
  res.json({ id });
});

app.delete("/api/reports/:id", (req, res) => {
  const teacherId = req.headers["teacher-id"];
  if (!teacherId) return res.status(401).json({ error: "Unauthorized" });
  db.prepare("DELETE FROM reports WHERE id = ? AND teacher_id = ?").run(req.params.id, teacherId);
  res.json({ success: true });
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
              students: new Map()
            });
          }
          
          currentRoomPin = pin;
          const room = rooms.get(pin);
          if (!room) break;
          
          // 3. Always send the current state back to the host
          const slides = db.prepare("SELECT * FROM slides WHERE presentation_id = ? ORDER BY \"order\" ASC").all(room.presentationId);
          const currentSlide = slides[room.currentSlideIndex];
          
          ws.send(JSON.stringify({ 
            type: "ROOM_CREATED", 
            pin,
            students: Array.from(room.students.entries()).map(([id, s]) => ({ 
              id, 
              name: s.name,
              avatarSeed: s.avatarSeed
            })),
            currentSlide: currentSlide ? {
              ...currentSlide,
              content: JSON.parse(currentSlide.content)
            } : null,
            currentSlideIndex: room.currentSlideIndex
          }));
          break;
        }

        case "JOIN_ROOM": {
          const room = rooms.get(message.pin);
          if (room) {
            studentId = nanoid(5);
            const avatarSeed = Math.random().toString(36).substring(7);
            room.students.set(studentId, { ws, name: message.name, avatarSeed, responses: {}, score: 0 });
            currentRoomPin = message.pin;
            
            ws.send(JSON.stringify({ 
              type: "JOIN_SUCCESS", 
              studentId,
              avatarSeed,
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
                name: message.name,
                avatarSeed,
                count: room.students.size 
              }));
            }

            // Send current slide state to student
            const slides = db.prepare("SELECT * FROM slides WHERE presentation_id = ? ORDER BY \"order\" ASC").all(room.presentationId);
            ws.send(JSON.stringify({ 
              type: "SLIDE_UPDATE", 
              index: room.currentSlideIndex,
              slide: (room.currentSlideIndex >= 0 && slides[room.currentSlideIndex]) 
                ? { ...slides[room.currentSlideIndex], content: JSON.parse(slides[room.currentSlideIndex].content) } 
                : null
            }));
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
            } else {
              room.currentSlideIndex++;
            }
            
            const slides = db.prepare("SELECT * FROM slides WHERE presentation_id = ? ORDER BY \"order\" ASC").all(room.presentationId);
            
            if (slides.length === 0) {
              ws.send(JSON.stringify({ type: "ERROR", message: "Презентацията няма слайдове. Моля добавете слайдове и ги запазете." }));
              break;
            }

            const nextSlide = slides[room.currentSlideIndex];
            
            if (!nextSlide && room.currentSlideIndex >= slides.length) {
              // End of presentation
              const finalUpdate = {
                type: "PRESENTATION_FINISHED",
                leaderboard: Array.from(room.students.values())
                  .map(s => ({ name: s.name, score: s.score, avatarSeed: s.avatarSeed }))
                  .sort((a, b) => b.score - a.score)
              };
              if (room.host.readyState === WebSocket.OPEN) {
                room.host.send(JSON.stringify(finalUpdate));
              }
              room.students.forEach(s => {
                if (s.ws.readyState === WebSocket.OPEN) {
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
              if (s.ws.readyState === WebSocket.OPEN) {
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
              if (s.ws.readyState === WebSocket.OPEN) {
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

        case "SUBMIT_RESPONSE": {
          if (!currentRoomPin) break;
          const room = rooms.get(currentRoomPin);
          if (room && studentId) {
            const student = room.students.get(studentId);
            if (student) {
              student.responses[room.currentSlideIndex] = message.response;
              
              // Score calculation
              const slides = db.prepare("SELECT * FROM slides WHERE presentation_id = ? ORDER BY \"order\" ASC").all(room.presentationId);
              const currentSlide = slides[room.currentSlideIndex];
              if (currentSlide) {
                const content = JSON.parse(currentSlide.content);
                const slidePoints = currentSlide.points || 100;
                let isCorrect = false;

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
                      if (dist < 10) { // 10% tolerance
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
                }

                if (isCorrect) {
                  student.score += slidePoints;
                }

                // Send feedback to student
                if (ws.readyState === WebSocket.OPEN) {
                  ws.send(JSON.stringify({
                    type: "FEEDBACK",
                    isCorrect,
                    pointsEarned: isCorrect ? slidePoints : 0,
                    totalScore: student.score
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
            if (s.ws.readyState === WebSocket.OPEN) {
              s.ws.send(JSON.stringify({ type: "ROOM_CLOSED" }));
            }
          });
          rooms.delete(currentRoomPin);
        } else if (studentId) {
          room.students.delete(studentId);
          if (room.host.readyState === WebSocket.OPEN) {
            room.host.send(JSON.stringify({ 
              type: "STUDENT_LEFT", 
              id: studentId,
              count: room.students.size 
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

  const reportData = {
    presentationTitle: presentation.title,
    date: new Date().toLocaleDateString("bg-BG"),
    students: Array.from(room.students.values()).map(s => ({
      name: s.name,
      score: s.score,
      responses: s.responses
    })),
    slides: slides.map(s => ({
      type: s.type,
      content: JSON.parse(s.content)
    }))
  };

  res.json(reportData);
});

// Vite middleware for development
if (process.env.NODE_ENV !== "production") {
  createViteServer({
    server: { middlewareMode: true },
    appType: "spa",
  }).then((vite) => {
    app.use(vite.middlewares);
  });
} else {
  app.use(express.static(path.join(__dirname, "dist")));
  app.get("*", (req, res) => {
    res.sendFile(path.join(__dirname, "dist", "index.html"));
  });
}

const PORT = 3000;
server.listen(PORT, "0.0.0.0", () => {
  console.log(`Server running on http://localhost:${PORT}`);
});

import express from "express";
import { createServer } from "http";
import { Server } from "socket.io";
import path from "path";
import { fileURLToPath } from "url";
import { createServer as createViteServer } from "vite";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function startServer() {
  const app = express();
  const httpServer = createServer(app);
  const io = new Server(httpServer, {
    cors: {
      origin: "*",
    }
  });

  const PORT = process.env.PORT ? parseInt(process.env.PORT) : 3000;

  // Health check for Render/Deployment
  app.get("/health", (req, res) => {
    res.status(200).send("OK");
  });

  // Track users
  const users = new Map<string, string>();

  io.on("connection", (socket) => {
    console.log("User connected:", socket.id);

    socket.on("join", (username: string) => {
      users.set(socket.id, username);
      
      // Tell everyone else about the new user
      socket.broadcast.emit("user-joined", { id: socket.id, username });
      
      // Send the current user list (excluding the joiner) to the joiner
      const otherUsers = Array.from(users.entries())
        .filter(([id]) => id !== socket.id)
        .map(([id, username]) => ({ id, username }));
      
      socket.emit("all-users", otherUsers);
    });

    socket.on("signal", ({ to, signal }) => {
      io.to(to).emit("signal", { from: socket.id, signal });
    });

    socket.on("mute-status", (isMuted: boolean) => {
      socket.broadcast.emit("peer-mute-status", { id: socket.id, isMuted });
    });

    socket.on("speaking-status", (isSpeaking: boolean) => {
      socket.broadcast.emit("peer-speaking-status", { id: socket.id, isSpeaking });
    });

    socket.on("disconnect", () => {
      console.log("User disconnected:", socket.id);
      users.delete(socket.id);
      io.emit("user-left", socket.id);
    });
  });

  // Vite integration
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  httpServer.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running at http://localhost:${PORT}`);
  });
}

startServer();

import { Server } from "socket.io";

let io;

export const initSocket = (httpServer) => {
  io = new Server(httpServer, {
    cors: {
      origin: ["https://mariaalgo.online", "http://localhost:3000"],
      methods: ["GET", "POST"],
    },
  });

  io.on("connection", (socket) => {
    console.log(`🔌 UI connected: ${socket.id}`);
    socket.on("disconnect", () =>
      console.log(`🔌 UI disconnected: ${socket.id}`)
    );
  });

  return io;
};

export const getIO = () => io || null;

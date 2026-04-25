# tera

A mobile-first, open group voice call app using WebRTC and Socket.IO.

## Deployment to Render.com

1.  **Create a new Web Service** on Render.
2.  **Connect your GitHub repository**.
3.  **Configure the service**:
    *   **Runtime**: `Node`
    *   **Build Command**: `npm install && npm run build`
    *   **Start Command**: `npm start`
4.  **Environment Variables**:
    *   `NODE_ENV`: `production`

## Features

- No rooms, no login
- High-quality WebRTC voice (Mesh network)
- Speaking indicators
- Mobile-optimized "Immersive UI"
- Auto-reconnection

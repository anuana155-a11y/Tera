/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useRef, useCallback } from "react";
import { io, Socket } from "socket.io-client";
import { Mic, MicOff, PhoneOff, User, Volume2, ShieldAlert } from "lucide-react";
import { motion, AnimatePresence } from "motion/react";
import { cn } from "./lib/utils";

// --- Types ---

interface PeerInfo {
  id: string;
  username: string;
  stream?: MediaStream;
  isSpeaking: boolean;
  isMuted: boolean;
}

// --- Icons & Helpers ---

const STUN_SERVERS = {
  iceServers: [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun1.l.google.com:19302" }
  ]
};

// --- Components ---

const Avatar = ({ name, isSpeaking, isMuted, size = "large" }: { name: string; isSpeaking?: boolean; isMuted?: boolean; size?: "small" | "large" }) => {
  const initials = name.slice(0, 2).toUpperCase();
  
  return (
    <div className="relative">
      <motion.div
        animate={isSpeaking ? { scale: [1, 1.05, 1] } : { scale: 1 }}
        transition={{ repeat: Infinity, duration: 1.5 }}
        className={cn(
          "rounded-full flex items-center justify-center font-bold transition-all duration-300",
          isSpeaking 
            ? "bg-gradient-to-br from-[#4ADE80] to-[#22C55E] text-white shadow-lg shadow-[#4ADE80]/20" 
            : "bg-[#2E3035] text-[#8E9299]",
          size === "large" ? "w-20 h-20 text-3xl" : "w-12 h-12 text-lg",
        )}
      >
        {initials || <User size={size === "large" ? 40 : 20} />}
      </motion.div>
      {isMuted && (
        <div className="absolute top-0 right-0 translate-x-1/4 -translate-y-1/4 bg-[#F87171] rounded-full p-1 border-2 border-[#151619] shadow-lg">
          <MicOff size={12} className="text-white" />
        </div>
      )}
      {isSpeaking && !isMuted && (
        <div className="absolute top-0 right-0 translate-x-1/4 -translate-y-1/4 bg-[#4ADE80] rounded-full p-1 border-2 border-[#151619] shadow-[0_0_10px_#4ADE80]">
          <Volume2 size={12} className="text-white animate-pulse" />
        </div>
      )}
    </div>
  );
};

export default function App() {
  const [username, setUsername] = useState("");
  const [isJoined, setIsJoined] = useState(false);
  const [isMuted, setIsMuted] = useState(false);
  const [peers, setPeers] = useState<Map<string, PeerInfo>>(new Map());
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isLocalSpeaking, setIsLocalSpeaking] = useState(false);

  const socketRef = useRef<Socket | null>(null);
  const peersRef = useRef<Map<string, RTCPeerConnection>>(new Map());
  const localStreamRef = useRef<MediaStream | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);

  // --- WebRTC Logic ---

  const createPeerConnection = useCallback((targetSocketId: string, username: string) => {
    const pc = new RTCPeerConnection(STUN_SERVERS);

    pc.onicecandidate = (event) => {
      if (event.candidate) {
        socketRef.current?.emit("signal", {
          to: targetSocketId,
          signal: { type: "candidate", candidate: event.candidate }
        });
      }
    };

    pc.ontrack = (event) => {
      setPeers((prev) => {
        const newPeers = new Map(prev);
        const peer = newPeers.get(targetSocketId) as PeerInfo | undefined;
        if (peer) {
          newPeers.set(targetSocketId, { ...peer, stream: event.streams[0] });
        }
        return newPeers;
      });
    };

    if (localStreamRef.current) {
      localStreamRef.current.getTracks().forEach((track) => {
        pc.addTrack(track, localStreamRef.current!);
      });
    }

    peersRef.current.set(targetSocketId, pc);
    return pc;
  }, []);

  // --- Volume Detection ---

  const setupVolumeDetection = useCallback((stream: MediaStream, callback: (isSpeaking: boolean) => void) => {
    const context = new (window.AudioContext || (window as any).webkitAudioContext)();
    audioContextRef.current = context;
    
    const source = context.createMediaStreamSource(stream);
    const analyst = context.createAnalyser();
    analyst.fftSize = 256;
    source.connect(analyst);

    const dataArray = new Uint8Array(analyst.frequencyBinCount);
    let speakingTimeout: NodeJS.Timeout | null = null;

    let isClosed = false;

    const check = () => {
      if (isClosed) return;
      analyst.getByteFrequencyData(dataArray);
      const average = dataArray.reduce((acc, val) => acc + val, 0) / dataArray.length;
      
      if (average > 30) { // Slightly increased threshold for better stability
        callback(true);
        if (speakingTimeout) clearTimeout(speakingTimeout);
        speakingTimeout = setTimeout(() => callback(false), 400);
      }
      requestAnimationFrame(check);
    };

    check();
    return () => {
      isClosed = true;
      if (speakingTimeout) clearTimeout(speakingTimeout);
      context.close();
    };
  }, []);

  const handleJoin = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    if (!username.trim()) return;

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ 
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true
        } 
      });
      localStreamRef.current = stream;
      setLocalStream(stream);

      // Self volume detection
      setupVolumeDetection(stream, (isSpeaking) => {
        setIsLocalSpeaking(isSpeaking);
        socketRef.current?.emit("speaking-status", isSpeaking);
      });

      const signalServer = import.meta.env.VITE_SIGNAL_SERVER || window.location.origin;
      socketRef.current = io(signalServer, {
        reconnectionAttempts: 5,
        timeout: 10000
      });

      socketRef.current.on("connect", () => {
        socketRef.current?.emit("join", username);
        setIsJoined(true);
      });

      socketRef.current.on("all-users", (users: { id: string; username: string }[]) => {
        const initialPeers = new Map<string, PeerInfo>();
        users.forEach(({ id, username: peerName }) => {
          initialPeers.set(id, { id, username: peerName, isSpeaking: false, isMuted: false });
        });
        setPeers(initialPeers);

        // Initiation phase
        users.forEach(({ id, username: peerName }) => {
          const pc = createPeerConnection(id, peerName);
          pc.createOffer().then((offer) => {
            pc.setLocalDescription(offer);
            socketRef.current?.emit("signal", { to: id, signal: offer });
          });
        });
      });

      socketRef.current.on("user-joined", ({ id, username: peerName }) => {
        setPeers((prev) => new Map(prev).set(id, { id, username: peerName, isSpeaking: false, isMuted: false }));
      });

      socketRef.current.on("signal", async ({ from, signal }: { from: string; signal: any }) => {
        let pc = peersRef.current.get(from);
        
        if (!pc) {
          const peerInfo = peers.get(from);
          pc = createPeerConnection(from, (peerInfo as PeerInfo)?.username || "Unknown");
        }

        if (signal.type === "offer") {
          await pc.setRemoteDescription(new RTCSessionDescription(signal));
          const answer = await pc.createAnswer();
          await pc.setLocalDescription(answer);
          socketRef.current?.emit("signal", { to: from, signal: answer });
        } else if (signal.type === "answer") {
          await pc.setRemoteDescription(new RTCSessionDescription(signal));
        } else if (signal.type === "candidate") {
          await pc.addIceCandidate(new RTCIceCandidate(signal.candidate));
        }
      });

      socketRef.current.on("user-left", (id) => {
        const pc = peersRef.current.get(id);
        if (pc) {
          pc.close();
          peersRef.current.delete(id);
        }
        setPeers((prev) => {
          const next = new Map(prev);
          next.delete(id);
          return next;
        });
      });

      socketRef.current.on("peer-mute-status", ({ id, isMuted }: { id: string; isMuted: boolean }) => {
        setPeers(prev => {
          const next = new Map(prev);
          const peer = next.get(id) as PeerInfo | undefined;
          if (peer) next.set(id, { ...peer, isMuted });
          return next;
        });
      });

      socketRef.current.on("peer-speaking-status", ({ id, isSpeaking }: { id: string; isSpeaking: boolean }) => {
        setPeers(prev => {
          const next = new Map(prev);
          const peer = next.get(id) as PeerInfo | undefined;
          if (peer) next.set(id, { ...peer, isSpeaking });
          return next;
        });
      });

    } catch (err) {
      console.error(err);
      setError("Please allow microphone access to join the call.");
    }
  };

  const handleLeave = () => {
    socketRef.current?.disconnect();
    localStreamRef.current?.getTracks().forEach(track => track.stop());
    peersRef.current.forEach(pc => pc.close());
    peersRef.current.clear();
    setPeers(new Map());
    setIsJoined(false);
    setLocalStream(null);
  };

  const toggleMute = () => {
    if (localStreamRef.current) {
      const enabled = !localStreamRef.current.getAudioTracks()[0].enabled;
      localStreamRef.current.getAudioTracks()[0].enabled = enabled;
      setIsMuted(!enabled);
      socketRef.current?.emit("mute-status", !enabled);
    }
  };

  // --- Render ---

  if (!isJoined) {
    return (
      <div className="min-h-screen-dynamic bg-[#050506] flex flex-col items-center justify-center p-4 font-sans text-white overflow-hidden relative">
        <div className="absolute inset-0 bg-gradient-to-b from-[#121214] to-[#050506] pointer-events-none"></div>

        <motion.div 
          initial={{ opacity: 0, scale: 0.95 }}
          animate={{ opacity: 1, scale: 1 }}
          className="relative z-10 w-full max-w-[390px] bg-[#0E0E10] p-8 rounded-[2.5rem] border border-[#2A2A2E] shadow-[0_0_60px_rgba(0,0,0,0.8)] overflow-hidden"
        >
          <div className="absolute top-0 left-1/2 -translate-x-1/2 w-32 h-6 bg-black rounded-b-2xl z-50"></div>
          
          <div className="flex flex-col items-center mb-10 pt-8">
            <h1 className="text-3xl font-bold tracking-tighter text-[#E0E0E0]">
              tera. <span className="text-[#4ADE80] text-sm font-normal align-top ml-1 uppercase">Live</span>
            </h1>
            <p className="text-[#8E9299] text-xs mt-2 uppercase tracking-widest font-semibold font-mono">Secure WebRTC Voice</p>
          </div>

          {error && (
            <motion.div 
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              className="mb-6 p-4 bg-[#F87171]/10 border border-[#F87171]/20 rounded-2xl flex items-start gap-3 text-[#F87171] text-sm"
            >
              <ShieldAlert size={18} className="shrink-0 mt-0.5" />
              <p>{error}</p>
            </motion.div>
          )}

          <form onSubmit={handleJoin} className="space-y-6">
            <div className="space-y-2">
              <label className="text-[10px] font-bold text-[#8E9299] uppercase tracking-widest px-1">Display Identity</label>
              <input
                type="text"
                placeholder="Ex. Sarah M."
                className="w-full bg-[#151619] border border-[#2A2A2E] rounded-2xl px-5 py-4 focus:outline-none focus:border-[#4ADE80] transition-all placeholder:text-[#444] text-white text-base"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                maxLength={20}
                required
                autoFocus
              />
            </div>
            
            <button
              type="submit"
              className="w-full bg-white text-black font-bold py-4 rounded-full transition-all active:scale-[0.98] shadow-lg shadow-white/5 h-14"
            >
              Enter Channel
            </button>
          </form>

          <div className="mt-10 flex flex-col items-center gap-2">
             <div className="flex items-center gap-1.5">
               <span className="w-1.5 h-1.5 rounded-full bg-[#4ADE80] animate-pulse"></span>
               <span className="text-[10px] text-[#444] uppercase tracking-widest font-bold">Encrypted Connection</span>
             </div>
          </div>
        </motion.div>
      </div>
    );
  }

  const peersArray = Array.from(peers.values()) as PeerInfo[];

  return (
    <div className="min-h-screen-dynamic bg-[#0E0E10] flex flex-col font-sans text-white w-full sm:max-w-[390px] mx-auto sm:border-x border-[#2A2A2E] relative overflow-hidden">
      <div className="absolute top-0 left-1/2 -translate-x-1/2 w-32 h-6 bg-black rounded-b-2xl z-50 hidden sm:block"></div>
      
      {/* Header */}
      <header className="pt-8 sm:pt-12 px-6 pb-6 flex items-center justify-between z-20">
        <div className="flex flex-col">
          <h1 className="text-2xl font-bold tracking-tighter text-[#E0E0E0]">
            tera. <span className="text-[#4ADE80] text-xs font-normal align-top ml-1 tracking-normal">LIVE</span>
          </h1>
          <div className="flex items-center gap-1.5 mt-1">
            <span className="w-1.5 h-1.5 rounded-full bg-[#4ADE80] animate-pulse"></span>
            <span className="text-[10px] text-[#8E9299] uppercase tracking-widest font-semibold">
              {peers.size + 1} Active Peers
            </span>
          </div>
        </div>
        <div className="w-10 h-10 rounded-full bg-[#1C1C1E] border border-[#2A2A2E] flex items-center justify-center text-[10px] font-mono text-[#8E9299]">
          ID:{Math.floor(Math.random() * 100)}
        </div>
      </header>

      {/* Main Grid */}
      <main className="flex-1 px-6 pb-40 overflow-y-auto z-10 scrollbar-hide">
        <div className="grid grid-cols-2 gap-4">
          {/* Local User */}
          <div className={cn(
            "relative flex flex-col items-center justify-center aspect-square rounded-[2rem] transition-all duration-500",
            isLocalSpeaking 
              ? "bg-[#151619] border-2 border-[#4ADE80] shadow-[0_0_20px_rgba(74,222,128,0.2)] scale-[1.02]" 
              : "bg-[#151619] border border-[#2A2A2E]"
          )}>
            <Avatar name={username} isMuted={isMuted} isSpeaking={isLocalSpeaking} />
            <span className={cn(
              "text-sm font-medium mt-3 transition-colors",
              isLocalSpeaking ? "text-white" : "text-[#8E9299]"
            )}>
              {username} (You)
            </span>
            {isLocalSpeaking && (
              <div className="absolute top-3 right-3">
                <div className="w-2 h-2 rounded-full bg-[#4ADE80] shadow-[0_0_8px_#4ADE80]"></div>
              </div>
            )}
          </div>

          {/* Remote Peers */}
          <AnimatePresence>
            {peersArray.map((peer) => (
              <motion.div
                key={peer.id}
                initial={{ opacity: 0, scale: 0.9 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.9 }}
                className={cn(
                  "relative flex flex-col items-center justify-center aspect-square rounded-[2rem] transition-all duration-500",
                  peer.isSpeaking 
                    ? "bg-[#151619] border-2 border-[#4ADE80] shadow-[0_0_20px_rgba(74,222,128,0.2)] scale-[1.02]" 
                    : "bg-[#151619] border border-[#2A2A2E]"
                )}
              >
                <Avatar name={peer.username} isSpeaking={peer.isSpeaking} isMuted={peer.isMuted} />
                <span className={cn(
                  "text-sm font-medium mt-3 transition-colors",
                  peer.isSpeaking ? "text-white" : "text-[#8E9299]"
                )}>
                  {peer.username}
                </span>
                {peer.stream && (
                  <AudioPlayer stream={peer.stream} />
                )}
                {peer.isSpeaking && !peer.isMuted && (
                  <div className="absolute top-3 right-3">
                    <div className="w-2 h-2 rounded-full bg-[#4ADE80] shadow-[0_0_8px_#4ADE80]"></div>
                  </div>
                )}
              </motion.div>
            ))}
          </AnimatePresence>

          {/* Empty invite slot if few users */}
          {peers.size < 5 && (
            <div className="flex flex-col items-center justify-center bg-dashed border-2 border-[#2A2A2E] border-dashed rounded-[2rem] aspect-square bg-transparent">
              <div className="w-8 h-8 rounded-full border border-[#2A2A2E] flex items-center justify-center text-[#8E9299] mb-1 font-bold">+</div>
              <span className="text-[10px] text-[#444] uppercase font-bold tracking-widest">Invite</span>
            </div>
          )}
        </div>
      </main>

      {/* Control Bar */}
      <footer className="fixed bottom-0 left-1/2 -translate-x-1/2 w-full sm:max-w-[390px] bg-[#1C1C1E] border-t border-[#2A2A2E] px-8 py-8 sm:px-10 sm:py-10 rounded-t-[2.5rem] z-30 shadow-[0_-15px_40px_rgba(0,0,0,0.6)] flex items-center justify-between pb-safe-offset-8">
        <button
          onClick={toggleMute}
          className={cn(
            "w-14 h-14 sm:w-16 sm:h-16 rounded-full flex items-center justify-center transition-all active:scale-95",
            isMuted 
              ? "bg-[#F87171] text-white shadow-[0_0_20px_rgba(248,113,113,0.3)] border-2 border-white/10" 
              : "bg-[#2E3035] text-white border border-[#3A3C41] hover:bg-[#3A3C41]"
          )}
        >
          {isMuted ? <MicOff size={24} /> : <Mic size={24} />}
        </button>
        
        <button
          onClick={handleLeave}
          className="w-16 h-16 sm:w-20 sm:h-20 bg-[#F87171] border-4 border-[#1C1C1E] text-white rounded-full flex items-center justify-center transition-all active:scale-95 shadow-[0_0_25px_rgba(248,113,113,0.3)]"
        >
          <PhoneOff size={28} />
        </button>

        <button
          className="w-14 h-14 sm:w-16 sm:h-16 bg-[#2E3035] border border-[#3A3C41] text-white rounded-full flex items-center justify-center transition-all active:scale-95 hover:bg-[#3A3C41]"
        >
          <Volume2 size={24} />
        </button>
      </footer>
    </div>
  );
}

// --- Helper Components ---

const AudioPlayer = ({ stream }: { stream: MediaStream }) => {
  const audioRef = useRef<HTMLAudioElement>(null);

  useEffect(() => {
    if (audioRef.current && stream) {
      audioRef.current.srcObject = stream;
    }
  }, [stream]);

  return <audio ref={audioRef} autoPlay playsInline />;
};

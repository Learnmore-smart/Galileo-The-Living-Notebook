import React, { useState, useRef, useEffect } from 'react';
import { Camera, RefreshCw, Zap, Mic, RotateCcw, StopCircle, SwitchCamera, AlertTriangle, X, CheckCircle } from 'lucide-react';
import { analyzeSketch, interpretVoiceCommand } from './services/geminiService';
import SimulationCanvas from './components/SimulationCanvas';
import { AppMode, PhysicsState, SceneConfig } from './types';

// Helper to encode Audio Blob to Base64
const blobToBase64 = (blob: Blob): Promise<string> => {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      const result = reader.result as string;
      const base64String = result.split(',')[1];
      resolve(base64String);
    };
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
};

const DEFAULT_PHYSICS: PhysicsState = {
  gravity: { x: 0, y: 9.81 },
  timeScale: 1,
  enableCollisionEffects: true,
};

// Polyfill for SpeechRecognition types
declare global {
  interface Window {
    webkitSpeechRecognition: any;
    SpeechRecognition: any;
  }
}

type ToastType = 'error' | 'success';

const App: React.FC = () => {
  const [mode, setMode] = useState<AppMode>(AppMode.CAMERA);
  const [sceneConfig, setSceneConfig] = useState<SceneConfig | null>(null);
  const [physicsState, setPhysicsState] = useState<PhysicsState>(DEFAULT_PHYSICS);
  const [loadingMsg, setLoadingMsg] = useState<string>('');
  
  // Toast State
  const [toastMsg, setToastMsg] = useState<{ type: ToastType, msg: string } | null>(null);

  const [isCameraFlipped, setIsCameraFlipped] = useState(false);
  
  // Subtitles
  const [liveTranscript, setLiveTranscript] = useState<string>('');
  const recognitionRef = useRef<any>(null);
  const finalTranscriptRef = useRef<string>('');
  // FIX: Track latest transcript in a ref to avoid stale closures in mediaRecorder.onstop
  const latestTranscriptRef = useRef<string>('');
  
  // Camera Refs
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const streamRef = useRef<MediaStream | null>(null);

  // Audio Refs
  const [isRecording, setIsRecording] = useState(false);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const recordingStartTime = useRef<number>(0);

  const showToast = (message: string, type: ToastType = 'error') => {
    setToastMsg({ type, msg: message });
    // Auto-dismiss after 6 seconds
    setTimeout(() => setToastMsg(null), 6000);
  };

  // Initialize Speech Recognition
  useEffect(() => {
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (SpeechRecognition) {
      const recognition = new SpeechRecognition();
      recognition.continuous = true;
      recognition.interimResults = true;
      recognition.lang = 'en-US';

      recognition.onresult = (event: any) => {
        let interimTranscript = '';
        for (let i = event.resultIndex; i < event.results.length; ++i) {
          if (event.results[i].isFinal) {
            finalTranscriptRef.current += event.results[i][0].transcript + ' ';
          } else {
            interimTranscript += event.results[i][0].transcript;
          }
        }
        const fullText = finalTranscriptRef.current + interimTranscript;
        setLiveTranscript(fullText);
        latestTranscriptRef.current = fullText; // Update Ref for immediate access
      };

      recognition.onerror = (event: any) => {
        console.error("Speech recognition error", event.error);
      };

      recognitionRef.current = recognition;
    }
  }, []);

  // Initialize Camera
  const startCamera = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ 
        video: { facingMode: 'environment' } 
      });
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        streamRef.current = stream;
      }
    } catch (err) {
      console.error("Camera error:", err);
      showToast("Optical Sensor Failure: Could not access camera. Please check permissions.", 'error');
    }
  };

  useEffect(() => {
    if (mode === AppMode.CAMERA) {
      startCamera();
    } else {
      if (streamRef.current) {
        streamRef.current.getTracks().forEach(track => track.stop());
        streamRef.current = null;
      }
    }
  }, [mode]);

  const handleCapture = async () => {
    if (!videoRef.current || !canvasRef.current) return;

    const video = videoRef.current;
    const canvas = canvasRef.current;
    
    // 640px limit for speed
    const MAX_DIMENSION = 640;
    let width = video.videoWidth;
    let height = video.videoHeight;
    
    if (width > height) {
      if (width > MAX_DIMENSION) {
        height = Math.round(height * (MAX_DIMENSION / width));
        width = MAX_DIMENSION;
      }
    } else {
      if (height > MAX_DIMENSION) {
        width = Math.round(width * (MAX_DIMENSION / height));
        height = MAX_DIMENSION;
      }
    }

    canvas.width = width;
    canvas.height = height;
    
    const ctx = canvas.getContext('2d');
    if (ctx) {
      ctx.save();
      // Apply mirroring to canvas if enabled, so simulation matches user view
      if (isCameraFlipped) {
        ctx.scale(-1, 1);
        ctx.drawImage(video, -width, 0, width, height);
      } else {
        ctx.drawImage(video, 0, 0, width, height);
      }
      ctx.restore();

      const imageData = canvas.toDataURL('image/jpeg', 0.6).split(',')[1];
      
      setMode(AppMode.ANALYZING);
      setLoadingMsg('Gemini is analyzing your sketch...');
      
      try {
        const config = await analyzeSketch(imageData);
        setSceneConfig(config);
        setMode(AppMode.SIMULATION);
      } catch (e: any) {
        console.error(e);
        const errorDetail = e.message || 'Unknown error';
        showToast(`Analysis Failed: ${errorDetail}. Try capturing a clearer image.`, 'error');
        setMode(AppMode.CAMERA);
      } finally {
        setLoadingMsg('');
      }
    }
  };

  const toggleRecording = async () => {
    if (isRecording) {
      // STOP RECORDING
      if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
        mediaRecorderRef.current.stop();
        setIsRecording(false);
      }
      if (recognitionRef.current) {
        recognitionRef.current.stop();
      }
    } else {
      // START RECORDING
      finalTranscriptRef.current = '';
      latestTranscriptRef.current = '';
      setLiveTranscript('');
      setToastMsg(null);
      
      if (recognitionRef.current) {
        try {
            recognitionRef.current.start();
        } catch(e) { console.log("Recognition already started"); }
      }

      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        
        const mediaRecorder = new MediaRecorder(stream);
        mediaRecorderRef.current = mediaRecorder;
        audioChunksRef.current = [];
        recordingStartTime.current = Date.now();

        mediaRecorder.ondataavailable = (event) => {
          if (event.data.size > 0) {
            audioChunksRef.current.push(event.data);
          }
        };

        mediaRecorder.onstop = async () => {
          const duration = Date.now() - recordingStartTime.current;
          
          if (duration < 500) {
            console.log("Audio too short, ignoring.");
            stream.getTracks().forEach(track => track.stop());
            return;
          }

          const audioBlob = new Blob(audioChunksRef.current, { type: mediaRecorder.mimeType });
          const base64Audio = await blobToBase64(audioBlob);
          
          setLoadingMsg('Processing...');
          
          try {
            // FIX: Use the ref to get the transcript that includes updates from the very last second
            const fullTranscript = latestTranscriptRef.current;
            console.log("Sending Transcript:", fullTranscript);

            // Pass current sceneConfig to allow removing objects
            const response = await interpretVoiceCommand(
                base64Audio, 
                physicsState, 
                sceneConfig, 
                mediaRecorder.mimeType, 
                fullTranscript
            );
            
            let commandExecuted = false;

            if (response.physicsUpdates) {
              setPhysicsState(prev => ({
                ...prev,
                ...response.physicsUpdates,
                gravity: { ...prev.gravity, ...(response.physicsUpdates?.gravity || {}) }
              }));
              if (Object.keys(response.physicsUpdates).length > 0) commandExecuted = true;
            }

            // Handle Additions and Updates
            if ((response.newBodies && response.newBodies.length > 0) || 
                (response.newConstraints && response.newConstraints.length > 0) ||
                (response.updatedBodies && response.updatedBodies.length > 0)) {
              
              setSceneConfig(prev => {
                const currentConfig = prev || { bodies: [], constraints: [] };
                // Ensure arrays exist
                const safeBodies = currentConfig.bodies || [];
                const safeConstraints = currentConfig.constraints || [];
                
                let updatedBodiesList = [...safeBodies];

                // Process Updates (Replace existing bodies with same ID)
                if (response.updatedBodies) {
                  response.updatedBodies.forEach(updatedBody => {
                    const index = updatedBodiesList.findIndex(b => b.id === updatedBody.id);
                    if (index !== -1) {
                      // Preserve position if not specified in update, but typically update has all fields
                      updatedBodiesList[index] = { ...updatedBodiesList[index], ...updatedBody };
                    }
                  });
                }

                return {
                  ...currentConfig,
                  bodies: [...updatedBodiesList, ...(response.newBodies || [])],
                  constraints: [...safeConstraints, ...(response.newConstraints || [])],
                };
              });
              commandExecuted = true;
            }

            // Handle Removals
            if (response.removeBodyIds && response.removeBodyIds.length > 0) {
              setSceneConfig(prev => {
                 if (!prev) return null;
                 const idsToRemove = response.removeBodyIds || [];
                 // Defensively check for arrays before filtering
                 const safeBodies = prev.bodies || [];
                 const safeConstraints = prev.constraints || [];

                 return {
                   ...prev,
                   bodies: safeBodies.filter(b => !idsToRemove.includes(b.id)),
                   constraints: safeConstraints.filter(c => 
                      !idsToRemove.includes(c.bodyAId) && 
                      (!c.bodyBId || !idsToRemove.includes(c.bodyBId))
                   )
                 };
              });
              commandExecuted = true;
            }

            if (commandExecuted || response.summary) {
               showToast(response.summary || "Command executed.", 'success');
            } else {
               showToast("Command not understood or no changes required.", 'error');
            }

          } catch (e: any) {
            console.error("Voice command failed", e);
            // Just show the message directly as it's now sanitized by the service or is a timeout
            showToast(e.message, 'error');
          } finally {
            setLoadingMsg('');
            // Do not clear transcript immediately so user can read it
            stream.getTracks().forEach(track => track.stop());
          }
        };

        mediaRecorder.start();
        setIsRecording(true);
      } catch (e) {
        console.error("Mic error:", e);
        showToast("Audio Sensor Error: Could not access microphone.", 'error');
      }
    }
  };

  const resetSimulation = () => {
    setPhysicsState(DEFAULT_PHYSICS);
    setMode(AppMode.CAMERA);
    setSceneConfig(null);
    setLiveTranscript('');
    latestTranscriptRef.current = '';
    setToastMsg(null);
  };

  return (
    <div className="min-h-screen font-mono text-cyan-400 bg-gray-900 flex flex-col items-center transition-colors duration-500 relative">
      <header className="w-full backdrop-blur border-b p-4 sticky top-0 z-50 flex justify-between items-center shadow-sm transition-colors bg-black/80 border-cyan-800">
        <div className="flex items-center gap-2">
          <div className="p-2 rounded-lg bg-cyan-600 text-black">
            <Zap size={20} fill="currentColor" />
          </div>
          <h1 className="text-xl font-bold tracking-tight">Living Notebook</h1>
        </div>
        {mode === AppMode.SIMULATION && (
           <div className="text-xs hidden sm:block text-cyan-600">
             Gravity: y={physicsState.gravity.y.toFixed(1)} | Time: {physicsState.timeScale}x
           </div>
        )}
      </header>
      
      {/* Toast Notification */}
      {toastMsg && (
        <div className="fixed top-24 left-1/2 -translate-x-1/2 z-[60] w-[90%] max-w-md animate-in fade-in slide-in-from-top-4 duration-300">
            <div className={`
              border rounded-xl shadow-2xl backdrop-blur-md p-4 flex items-start gap-3
              ${toastMsg.type === 'error' 
                ? 'bg-red-950/90 border-red-500/50' 
                : 'bg-green-950/90 border-green-500/50'
              }
            `}>
                <div className={`p-2 rounded-full mt-1 shrink-0 ${toastMsg.type === 'error' ? 'bg-red-900/50' : 'bg-green-900/50'}`}>
                    {toastMsg.type === 'error' ? <AlertTriangle className="text-red-400" size={20} /> : <CheckCircle className="text-green-400" size={20} />}
                </div>
                <div className="flex-1">
                    <h4 className={`font-bold text-sm uppercase tracking-wider mb-1 ${toastMsg.type === 'error' ? 'text-red-400' : 'text-green-400'}`}>
                      {toastMsg.type === 'error' ? 'System Alert' : 'Command Executed'}
                    </h4>
                    <p className={`text-sm leading-relaxed ${toastMsg.type === 'error' ? 'text-red-200' : 'text-green-200'}`}>
                      {toastMsg.msg}
                    </p>
                </div>
                <button 
                  onClick={() => setToastMsg(null)} 
                  className={`p-1 rounded-lg transition-colors ${
                    toastMsg.type === 'error' ? 'text-red-400 hover:bg-red-900/50' : 'text-green-400 hover:bg-green-900/50'
                  }`}
                >
                    <X size={20} />
                </button>
            </div>
        </div>
      )}

      <main className="flex-1 w-full max-w-4xl p-4 flex flex-col gap-4 relative z-0">
        
        {/* Transparent Loading Overlay */}
        {loadingMsg && (
          <div className="absolute inset-0 z-50 flex flex-col items-center justify-center bg-black/40 backdrop-blur-[2px] rounded-xl transition-all">
             <div className="bg-black/80 p-6 rounded-2xl flex flex-col items-center border border-cyan-500/30 shadow-2xl shadow-cyan-900/30">
                <RefreshCw className="animate-spin text-cyan-400 mb-4" size={40} />
                <p className="text-lg font-medium animate-pulse text-cyan-200">{loadingMsg}</p>
             </div>
          </div>
        )}

        <div className="relative w-full aspect-[4/3] rounded-xl shadow-lg shadow-cyan-900/50 overflow-hidden border-2 bg-gray-900 border-cyan-500">
          
          {/* Flip Toggle Button */}
          {mode === AppMode.CAMERA && (
            <button 
              onClick={() => setIsCameraFlipped(p => !p)}
              className="absolute top-4 right-4 z-20 p-2 bg-black/50 text-cyan-400 rounded-full hover:bg-black/70 transition-colors"
              title="Flip Camera"
            >
              <SwitchCamera size={24} />
            </button>
          )}

          {mode === AppMode.CAMERA && (
            <>
              <video 
                ref={videoRef} 
                autoPlay 
                playsInline 
                muted
                className={`w-full h-full object-cover opacity-80 transition-transform duration-300 ${isCameraFlipped ? 'scale-x-[-1]' : ''}`}
              />
              <canvas ref={canvasRef} className="hidden" />
              <div className="absolute inset-0 border-[20px] border-black/50 pointer-events-none" />
              <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                <div className="w-64 h-64 border-2 border-dashed border-cyan-400/50 rounded-lg"></div>
                <p className="absolute bottom-10 text-cyan-400/80 bg-black/50 px-3 py-1 rounded">Align sketch here</p>
              </div>
            </>
          )}

          {mode === AppMode.ANALYZING && (
             <div className="w-full h-full bg-gray-900 flex items-center justify-center">
                <p className="text-cyan-500 animate-pulse">Scanning geometry...</p>
             </div>
          )}

          {mode === AppMode.SIMULATION && sceneConfig && (
            <>
                <SimulationCanvas sceneConfig={sceneConfig} physicsState={physicsState} />
                
                {/* Live Subtitles Overlay */}
                <div className={`absolute bottom-8 left-0 right-0 text-center pointer-events-none transition-opacity duration-300 ${liveTranscript ? 'opacity-100' : 'opacity-0'}`}>
                    <span className="inline-block bg-black/80 backdrop-blur text-cyan-200 px-6 py-3 rounded-2xl text-lg font-medium border border-cyan-500/30 max-w-[80%]">
                        {liveTranscript}
                    </span>
                </div>
            </>
          )}
        </div>

        <div className="w-full flex flex-col gap-4">
          
          {mode === AppMode.CAMERA ? (
             <button 
               onClick={handleCapture}
               className="w-full py-4 bg-cyan-600 hover:bg-cyan-500 text-black rounded-xl font-bold text-lg shadow-lg shadow-cyan-900/50 transition-all active:scale-95 flex items-center justify-center gap-2"
             >
               <Camera size={24} />
               Simulate Sketch
             </button>
          ) : (
            <div className="grid grid-cols-2 gap-4">
              <button 
                onClick={toggleRecording}
                className={`
                  py-4 rounded-xl font-bold text-lg shadow-lg transition-all active:scale-95 flex items-center justify-center gap-2
                  ${isRecording 
                    ? 'bg-red-500 text-white shadow-red-900/50' 
                    : 'bg-cyan-600 text-black shadow-cyan-900/50 hover:bg-cyan-500'
                  }
                `}
              >
                {isRecording ? <StopCircle size={24} /> : <Mic size={24} />}
                {isRecording ? 'Stop & Send' : 'Voice Command'}
              </button>
              
              <button 
                onClick={resetSimulation}
                className="py-4 border-2 rounded-xl font-bold text-lg shadow-sm transition-all active:scale-95 flex items-center justify-center gap-2 bg-gray-800 border-gray-700 text-cyan-400 hover:border-cyan-500"
              >
                <RotateCcw size={24} />
                New Sketch
              </button>
            </div>
          )}

          <div className="p-4 rounded-lg text-sm border transition-colors bg-gray-800/50 border-gray-700 text-gray-400">
             <h3 className="font-bold mb-1 text-cyan-500">Gemini 3.0 Pro Control:</h3>
             {mode === AppMode.CAMERA ? (
               <ul className="list-disc pl-4 space-y-1">
                 <li>Draw <strong>circles</strong> (balls) and <strong>rectangles</strong>.</li>
                 <li>Tap "Simulate" to render!</li>
               </ul>
             ) : (
               <ul className="list-disc pl-4 space-y-1">
                 <li>Try: "Add a pendulum", "Add a heavy box"</li>
                 <li>Try: "Earth gravity", "Zero gravity", "Explode"</li>
                 <li><strong>Scroll</strong> to Zoom (aspect ratio locked)</li>
               </ul>
             )}
          </div>
        </div>

      </main>
    </div>
  );
};

export default App;
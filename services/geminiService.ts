import { GoogleGenAI, Type, GenerateContentResponse } from "@google/genai";
import { SceneConfig, PhysicsState, VoiceCommandResponse, BodyDef, ConstraintDef } from "../types";

const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });

// Use Flash for vision speed
const VISION_MODEL = "gemini-2.5-flash"; 
// Use Flash for voice speed
const VOICE_MODEL = "gemini-2.5-flash";

// Increased timeout to 60s for slower connections/larger audio
const timeoutPromise = (ms: number) => new Promise<never>((_, reject) => 
  setTimeout(() => reject(new Error(`Request timed out after ${ms/1000}s`)), ms)
);

// Helper to clean JSON string if model adds markdown blocks or conversational text
const cleanJson = (text: string): string => {
  // First strip markdown code blocks
  let cleaned = text.replace(/```json/g, '').replace(/```/g, '');
  
  // Find the first '{' and last '}' to extract the JSON object
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  
  if (start !== -1 && end !== -1) {
    return cleaned.substring(start, end + 1);
  }
  
  return cleaned.trim();
};

const sanitizeNumber = (val: any, min: number, max: number, fallback: number | undefined): number => {
  const n = parseFloat(val);
  if (isNaN(n) || !isFinite(n)) return fallback !== undefined ? fallback : min;
  return Math.min(Math.max(n, min), max);
};

export const analyzeSketch = async (base64Image: string): Promise<SceneConfig> => {
  const prompt = `
    Analyze this physics sketch (canvas 800x600).
    Identify physics bodies.
    
    CRITICAL INTERPRETATION RULES:
    1. SOLID SHAPES vs LINES: 
       - If you see a SQUARE, RECTANGLE, or CIRCLE drawn as an outline, interpret it as a SINGLE SOLID BODY. 
       - DO NOT break a square into 4 separate line segments.
       - DO NOT break a circle into arcs.
    
    2. CLASSIFICATION:
       - Square/Box/Block -> DYNAMIC RECTANGLE (isStatic: false).
       - Circle/Ball -> DYNAMIC CIRCLE (isStatic: false).
       - Long single line / Horizon -> STATIC WALL/FLOOR (isStatic: true).
       - "U" shape or "Bucket" -> 3 Static Walls.
    
    3. PENDULUMS: If a shape is hanging from a line, create a constraint.
    
    4. COORDINATES: Normalize to 800x600. (0,0 is top-left).
    
    Return JSON.
  `;

  try {
    const response = await Promise.race([
      ai.models.generateContent({
        model: VISION_MODEL,
        contents: {
          parts: [
            { inlineData: { mimeType: "image/jpeg", data: base64Image } },
            { text: prompt },
          ],
        },
        config: {
          responseMimeType: "application/json",
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              bodies: {
                type: Type.ARRAY,
                items: {
                  type: Type.OBJECT,
                  properties: {
                    id: { type: Type.STRING },
                    type: { type: Type.STRING, enum: ["circle", "rectangle"] },
                    x: { type: Type.NUMBER },
                    y: { type: Type.NUMBER },
                    width: { type: Type.NUMBER },
                    height: { type: Type.NUMBER },
                    radius: { type: Type.NUMBER },
                    angle: { type: Type.NUMBER },
                    isStatic: { type: Type.BOOLEAN },
                    color: { type: Type.STRING },
                    friction: { type: Type.NUMBER },
                  },
                  required: ["id", "type", "x", "y", "isStatic"],
                },
              },
              constraints: {
                type: Type.ARRAY,
                items: {
                  type: Type.OBJECT,
                  properties: {
                    bodyAId: { type: Type.STRING },
                    pointB: {
                      type: Type.OBJECT,
                      properties: {
                        x: { type: Type.NUMBER },
                        y: { type: Type.NUMBER },
                      },
                      required: ["x", "y"],
                    },
                  },
                  required: ["bodyAId", "pointB"],
                },
              },
            },
            required: ["bodies"],
          },
        },
      }),
      timeoutPromise(30000)
    ]) as GenerateContentResponse;

    if (response.text) {
      const parsed = JSON.parse(cleanJson(response.text));
      // Ensure arrays are initialized
      return {
        bodies: parsed.bodies || [],
        constraints: parsed.constraints || []
      } as SceneConfig;
    }
    throw new Error("No data returned from Gemini");
  } catch (error) {
    console.error("Gemini Analysis Error:", error);
    throw error;
  }
};

export const interpretVoiceCommand = async (
  audioBase64: string,
  currentPhysics: PhysicsState,
  currentScene: SceneConfig | null,
  mimeType: string = "audio/wav",
  transcriptHint: string = ""
): Promise<VoiceCommandResponse> => {
  
  if (!audioBase64 || audioBase64.length < 100) {
    throw new Error("Audio recording was too short or empty.");
  }

  // Construct a detailed context string including DIMENSIONS and FRICTION
  const bodyContext = currentScene?.bodies.map(b => {
    const dim = b.type === 'circle' ? `r:${Math.round(b.radius || 0)}` : `w:${Math.round(b.width || 0)} h:${Math.round(b.height || 0)}`;
    const fric = b.friction !== undefined ? ` friction:${b.friction}` : '';
    return `- ${b.type} (ID: "${b.id}") at [${Math.round(b.x)}, ${Math.round(b.y)}] size[${dim}]${fric}`;
  }).join('\n') || "No bodies in scene.";

  const prompt = `
    You are an omnipotent physics engine assistant. 
    Canvas Size: 800x600. Center: 400, 300.
    
    ********************************************************
    CONTEXT:
    TRANSCRIPT: "${transcriptHint}"
    EXISTING BODIES:
    ${bodyContext}
    ********************************************************

    INSTRUCTIONS:
    1. INTELLIGENT TYPO CORRECTION:
       - The transcript may have phonetic errors. INTERPRET INTENT based on physics context.
       - "Fiction" -> "Friction".
       - "Pendelum" / "Pandulum" -> "Pendulum".
       - "Wait" -> "Weight" (implies size/mass).
       - "Mask" -> "Mass".
    
    2. CREATION RULES (ADD):
       - "Platform" / "Ground" / "Floor" -> Create STATIC rectangle.
       - "Wall" -> Create STATIC vertical rectangle.
       - When adding a new body, APPLY ALL ADJECTIVES IMMEDIATELY to 'newBodies'.
       - "Add a slippery box" -> Create box in 'newBodies' with friction: 0.001.
       - "Add a red ball" -> Create ball in 'newBodies' with color: "#ff0000".
       - "Add a heavy block" -> Create larger rectangle.
    
    3. PROPERTIES & MODIFIERS:
       - FRICTION (0.0 to 1.0): 
          * "Ice", "Slippery", "No friction" -> friction: 0.001
          * "Normal" -> friction: 0.1
          * "Sticky", "Rough", "High friction", "With friction" -> friction: 0.9
       - POSITION:
          * If position is not specified for a new object, place it near the center (x:400, y:200) so it drops.
          * "Floor" / "Ground" -> y: 580, width: 800, height: 40.

    4. GRAVITY & PHYSICS (CRITICAL: Units are m/s²):
       - DEFAULT EARTH GRAVITY is 9.81.
       - "Moon" gravity -> y: 1.62.
       - "Mars" gravity -> y: 3.71.
       - "Jupiter" or "High" gravity -> y: 24.79.
       - "Zero" / "No" gravity -> y: 0.
       - "Invert" / "Reverse" gravity -> y: -9.81.
       - TIME SCALE: Default is 1. DO NOT change 'timeScale' unless the user explicitly asks for "Slow motion" (0.5) or "Fast forward" (2.0).

    5. COMPLEX OBJECTS:
       - "Pendulum" -> 
         * Create Body A: Static small circle (Pivot).
         * Create Body B: Dynamic circle (Bob).
         * Create Constraint: Connect A and B.
       - "Ramp" -> Static rectangle with angle (e.g., 0.5 radians).

    6. ACTIONS:
       - MODIFY: If the user says "Make the box slippery", find the 'box' in EXISTING BODIES and return it in 'updatedBodies' with new friction.
       - ADD: Return in 'newBodies'.
       - REMOVE: Return ID in 'removeBodyIds'.

    Return JSON only. No markdown. No explanations.
  `;

  try {
    const response = await Promise.race([
      ai.models.generateContent({
        model: VOICE_MODEL,
        contents: {
          parts: [
            { inlineData: { mimeType: mimeType, data: audioBase64 } },
            { text: prompt },
          ],
        },
        config: {
          responseMimeType: "application/json",
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              summary: { type: Type.STRING },
              physicsUpdates: {
                type: Type.OBJECT,
                properties: {
                  gravity: {
                    type: Type.OBJECT,
                    properties: { x: { type: Type.NUMBER }, y: { type: Type.NUMBER } },
                  },
                  timeScale: { type: Type.NUMBER },
                  enableCollisionEffects: { type: Type.BOOLEAN },
                },
              },
              newBodies: {
                type: Type.ARRAY,
                items: {
                  type: Type.OBJECT,
                  properties: {
                    id: { type: Type.STRING },
                    type: { type: Type.STRING },
                    x: { type: Type.NUMBER },
                    y: { type: Type.NUMBER },
                    width: { type: Type.NUMBER },
                    height: { type: Type.NUMBER },
                    radius: { type: Type.NUMBER },
                    angle: { type: Type.NUMBER },
                    isStatic: { type: Type.BOOLEAN },
                    color: { type: Type.STRING },
                    friction: { type: Type.NUMBER },
                  },
                  required: ["id", "type", "x", "y", "isStatic"],
                },
              },
              updatedBodies: {
                type: Type.ARRAY,
                items: {
                  type: Type.OBJECT,
                  properties: {
                    id: { type: Type.STRING },
                    type: { type: Type.STRING },
                    x: { type: Type.NUMBER },
                    y: { type: Type.NUMBER },
                    width: { type: Type.NUMBER },
                    height: { type: Type.NUMBER },
                    radius: { type: Type.NUMBER },
                    angle: { type: Type.NUMBER },
                    isStatic: { type: Type.BOOLEAN },
                    color: { type: Type.STRING },
                    friction: { type: Type.NUMBER },
                  },
                  required: ["id"],
                },
              },
              newConstraints: {
                type: Type.ARRAY,
                items: {
                  type: Type.OBJECT,
                  properties: {
                    bodyAId: { type: Type.STRING },
                    bodyBId: { type: Type.STRING },
                    pointB: {
                      type: Type.OBJECT,
                      properties: { x: { type: Type.NUMBER }, y: { type: Type.NUMBER } },
                    },
                    length: { type: Type.NUMBER },
                    stiffness: { type: Type.NUMBER },
                  },
                  required: ["bodyAId"],
                },
              },
              removeBodyIds: {
                type: Type.ARRAY,
                items: { type: Type.STRING },
              }
            },
            required: ["summary"]
          },
        },
      }),
      // Increased timeout to 30s to prevent early termination
      timeoutPromise(30000)
    ]) as GenerateContentResponse;

    if (response.text) {
      let result: VoiceCommandResponse;
      try {
        result = JSON.parse(cleanJson(response.text)) as VoiceCommandResponse;
      } catch (parseError) {
        console.error("JSON Parse Error:", parseError, "Raw Text:", response.text);
        throw new Error("I heard you, but I couldn't process the command (Invalid Response).");
      }
      
      const timestamp = Date.now().toString().slice(-4);
      const idMap: Record<string, string> = {};

      // Sanitize New Bodies
      if (result.newBodies) {
        result.newBodies.forEach(b => {
          const oldId = b.id;
          const newId = `${b.id}_${timestamp}`;
          b.id = newId;
          idMap[oldId] = newId;
          
          // Strict number sanitization
          b.friction = sanitizeNumber(b.friction, 0, 1, 0.1);
          b.x = sanitizeNumber(b.x, -2000, 2000, 400);
          b.y = sanitizeNumber(b.y, -2000, 2000, 300);
          if (b.type === 'circle') b.radius = sanitizeNumber(b.radius, 1, 400, 20);
          if (b.type === 'rectangle') {
            b.width = sanitizeNumber(b.width, 1, 2000, 100);
            b.height = sanitizeNumber(b.height, 1, 2000, 20);
          }
        });
      }

      // Sanitize Updated Bodies
      if (result.updatedBodies) {
        result.updatedBodies.forEach(b => {
          if (b.friction !== undefined) b.friction = sanitizeNumber(b.friction, 0, 1, 0.1);
          if (b.x !== undefined) b.x = sanitizeNumber(b.x, -2000, 2000, b.x);
          if (b.y !== undefined) b.y = sanitizeNumber(b.y, -2000, 2000, b.y);
          if (b.radius !== undefined) b.radius = sanitizeNumber(b.radius, 1, 400, b.radius);
          if (b.width !== undefined) b.width = sanitizeNumber(b.width, 1, 2000, b.width);
          if (b.height !== undefined) b.height = sanitizeNumber(b.height, 1, 2000, b.height);
        });
      }

      // Sanitize Constraints
      if (result.newConstraints) {
        result.newConstraints.forEach(c => {
          if (idMap[c.bodyAId]) c.bodyAId = idMap[c.bodyAId];
          if (c.bodyBId && idMap[c.bodyBId]) c.bodyBId = idMap[c.bodyBId];
          
          if (c.stiffness !== undefined) c.stiffness = sanitizeNumber(c.stiffness, 0.001, 1, 0.1);
          if (c.length !== undefined) c.length = sanitizeNumber(c.length, 1, 1000, undefined);
        });
      }

      return result;
    }
    throw new Error("I couldn't understand what you mean.");
  } catch (error: any) {
    console.error("Gemini Voice Error:", error);
    // Return friendly errors for common issues
    if (error.message.includes("timed out")) {
        throw new Error("I couldn't understand what you mean (Request Timed Out).");
    }
    // Return the specific error if we threw it manually (like Invalid Response)
    if (error.message.includes("Invalid Response")) {
        throw error;
    }
    // For any other error (including blocked content), use the friendly message
    throw new Error("I couldn't understand what you mean.");
  }
};
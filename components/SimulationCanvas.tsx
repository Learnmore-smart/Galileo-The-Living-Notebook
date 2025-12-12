import React, { useEffect, useRef } from 'react';
import Matter from 'matter-js';
import { SceneConfig, PhysicsState } from '../types';

interface SimulationCanvasProps {
  sceneConfig: SceneConfig;
  physicsState: PhysicsState;
}

const SimulationCanvas: React.FC<SimulationCanvasProps> = ({ sceneConfig, physicsState }) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const engineRef = useRef<Matter.Engine | null>(null);
  const renderRef = useRef<Matter.Render | null>(null);
  const runnerRef = useRef<Matter.Runner | null>(null);

  // Initialize Engine
  useEffect(() => {
    if (!containerRef.current) return;
    
    // Safety check for zero size container
    if (containerRef.current.clientWidth === 0 || containerRef.current.clientHeight === 0) return;

    // Setup Matter.js
    const Engine = Matter.Engine;
    const Render = Matter.Render;
    const Runner = Matter.Runner;
    const World = Matter.World;
    const Bodies = Matter.Bodies;
    const Composite = Matter.Composite;
    const Constraint = Matter.Constraint;
    const Mouse = Matter.Mouse;
    const MouseConstraint = Matter.MouseConstraint;
    const Events = Matter.Events;

    const engine = Engine.create();
    engineRef.current = engine;

    const width = containerRef.current.clientWidth;
    const height = containerRef.current.clientHeight;

    const render = Render.create({
      element: containerRef.current,
      engine: engine,
      options: {
        width: width,
        height: height,
        wireframes: false,
        background: 'transparent',
        hasBounds: true,
        pixelRatio: window.devicePixelRatio,
      },
    });
    renderRef.current = render;

    // Initial View: 800x600 centered with padding
    const PADDING = 100;
    Render.lookAt(render, {
      min: { x: -PADDING, y: -PADDING },
      max: { x: 800 + PADDING, y: 600 + PADDING }
    });

    // Styles for "Neon 3D" look
    const defaultFill = '#22d3ee'; // Cyan
    const dynamicFill = '#f472b6'; // Pink
    
    // Add Bodies from Config
    const bodiesMap = new Map<string, Matter.Body>();

    try {
      sceneConfig.bodies.forEach((def) => {
        let body: Matter.Body;
        
        // Determine Border Color based on Friction
        // Ice (< 0.05) -> Blue/Cyan border
        // Sticky (> 0.5) -> Amber/Orange border
        // Normal -> White border
        const friction = def.friction !== undefined ? def.friction : 0.1;
        let strokeColor = '#fff'; 
        if (friction < 0.05) strokeColor = '#67e8f9'; // Cyan-300
        else if (friction > 0.5) strokeColor = '#fbbf24'; // Amber-400

        const commonOptions = {
          isStatic: def.isStatic,
          angle: def.angle || 0,
          friction: friction,
          restitution: 0.6,
          render: {
            fillStyle: def.color || (def.isStatic ? defaultFill : dynamicFill),
            strokeStyle: strokeColor,
            lineWidth: friction > 0.5 || friction < 0.05 ? 4 : 2, // Thicker border for modified friction
            opacity: 0.9,
          },
          label: def.id,
        };
        
        const x = def.x; 
        const y = def.y;

        // Safety: Ensure finite coordinates
        if (!Number.isFinite(x) || !Number.isFinite(y)) return;

        if (def.type === 'circle') {
          body = Bodies.circle(x, y, def.radius || 20, commonOptions);
        } else {
          body = Bodies.rectangle(x, y, def.width || 100, def.height || 20, commonOptions);
        }
        
        bodiesMap.set(def.id, body);
        Composite.add(engine.world, body);
      });
    } catch (err) {
      console.error("Error creating bodies:", err);
    }

    // Add Constraints
    if (sceneConfig.constraints) {
      sceneConfig.constraints.forEach((cDef) => {
        try {
          const bodyA = bodiesMap.get(cDef.bodyAId);
          const bodyB = cDef.bodyBId ? bodiesMap.get(cDef.bodyBId) : undefined;
          
          if (bodyA) {
            const options: any = {
              bodyA: bodyA,
              pointB: cDef.pointB || (bodyB ? undefined : { x: 0, y: 0 }),
              stiffness: cDef.stiffness || 0.1,
              length: cDef.length, 
              render: {
                strokeStyle: '#a78bfa',
                lineWidth: 3,
                anchors: true,
              }
            };
            if (bodyB) options.bodyB = bodyB;

            const constraint = Constraint.create(options);
            Composite.add(engine.world, constraint);
          }
        } catch (err) {
          console.warn("Failed to create constraint:", cDef, err);
        }
      });
    }

    // Add Mouse Control
    const mouse = Mouse.create(render.canvas);
    const mouseConstraint = MouseConstraint.create(engine, {
      mouse: mouse,
      constraint: {
        stiffness: 0.2,
        render: { visible: false }
      }
    });
    Composite.add(engine.world, mouseConstraint);
    render.mouse = mouse;

    // Boundaries
    const WALL_THICKNESS = 2000; 
    const WORLD_WIDTH = 800;
    const WORLD_HEIGHT = 600;
    Composite.add(engine.world, [
      Bodies.rectangle(WORLD_WIDTH/2, -WALL_THICKNESS/2, WORLD_WIDTH + WALL_THICKNESS*2, WALL_THICKNESS, { isStatic: true, render: { visible: false } }), 
      Bodies.rectangle(WORLD_WIDTH/2, WORLD_HEIGHT + WALL_THICKNESS/2, WORLD_WIDTH + WALL_THICKNESS*2, WALL_THICKNESS, { isStatic: true, render: { visible: false } }), 
      Bodies.rectangle(-WALL_THICKNESS/2, WORLD_HEIGHT/2, WALL_THICKNESS, WORLD_HEIGHT + WALL_THICKNESS*2, { isStatic: true, render: { visible: false } }), 
      Bodies.rectangle(WORLD_WIDTH + WALL_THICKNESS/2, WORLD_HEIGHT/2, WALL_THICKNESS, WORLD_HEIGHT + WALL_THICKNESS*2, { isStatic: true, render: { visible: false } })
    ]);

    // View Sync
    Events.on(render, 'beforeRender', () => {
      const mouse = mouseConstraint.mouse;
      const bounds = render.bounds;
      const width = render.options.width!;
      const height = render.options.height!;
      const scaleX = (bounds.max.x - bounds.min.x) / width;
      const scaleY = (bounds.max.y - bounds.min.y) / height;
      Matter.Mouse.setScale(mouse, { x: scaleX, y: scaleY });
      Matter.Mouse.setOffset(mouse, bounds.min);
    });

    // Zoom
    const handleWheel = (e: WheelEvent) => {
      e.preventDefault();
      const zoomFactor = e.deltaY > 0 ? 1.1 : 0.9;
      const bounds = render.bounds;
      const dx = bounds.max.x - bounds.min.x;
      if (dx > 4000 && zoomFactor > 1) return;
      if (dx < 100 && zoomFactor < 1) return;
      const center = { x: (bounds.min.x + bounds.max.x) / 2, y: (bounds.min.y + bounds.max.y) / 2 };
      const newDx = dx * zoomFactor;
      const aspectRatio = render.canvas.height / render.canvas.width;
      const newDy = newDx * aspectRatio; 
      Render.lookAt(render, {
        min: { x: center.x - newDx / 2, y: center.y - newDy / 2 },
        max: { x: center.x + newDx / 2, y: center.y + newDy / 2 }
      });
    };
    render.canvas.addEventListener('wheel', handleWheel);

    // Collision
    Events.on(engine, 'collisionStart', (event) => {
        if (!physicsState.enableCollisionEffects) return;
        event.pairs.forEach((pair) => {
            const collisionPoint = pair.collision.supports[0];
            if (collisionPoint) {
                (render as any).flash = { x: collisionPoint.x, y: collisionPoint.y, frame: 0 };
            }
        });
    });

    // Render Loop
    Events.on(render, 'afterRender', () => {
        try {
            const ctx = render.context;
            (Render as any).startViewTransform(render);

            // Boundary Box
            ctx.strokeStyle = 'rgba(34, 211, 238, 0.3)';
            ctx.lineWidth = 2;
            ctx.setLineDash([10, 10]);
            ctx.strokeRect(0, 0, 800, 600);
            ctx.setLineDash([]);
            
            // Corners
            ctx.fillStyle = 'rgba(34, 211, 238, 0.5)';
            const cornerSize = 10;
            ctx.fillRect(-cornerSize, -cornerSize, cornerSize*2, cornerSize*2);
            ctx.fillRect(800-cornerSize, -cornerSize, cornerSize*2, cornerSize*2);
            ctx.fillRect(800-cornerSize, 600-cornerSize, cornerSize*2, cornerSize*2);
            ctx.fillRect(-cornerSize, 600-cornerSize, cornerSize*2, cornerSize*2);
            
            ctx.fillStyle = 'rgba(34, 211, 238, 0.5)';
            ctx.font = '12px monospace';
            ctx.fillText("SIMULATION BOUNDARY (800x600)", 10, -10);

            // Sparks
            const flash = (render as any).flash;
            if (flash && flash.frame < 10 && Number.isFinite(flash.x) && Number.isFinite(flash.y)) {
                ctx.beginPath();
                ctx.arc(flash.x, flash.y, 25 - flash.frame, 0, 2 * Math.PI);
                ctx.fillStyle = `rgba(255, 255, 255, ${0.8 - flash.frame / 12})`;
                ctx.shadowBlur = 10;
                ctx.shadowColor = "white";
                ctx.fill();
                ctx.shadowBlur = 0;
                flash.frame++;
            }

            // 3D Effects
            Composite.allBodies(engine.world).forEach(body => {
                if (!Number.isFinite(body.position.x) || !Number.isFinite(body.position.y)) return;
                if (body.render.visible && body.render.fillStyle !== 'transparent') {
                    ctx.save();
                    ctx.translate(body.position.x, body.position.y);
                    ctx.rotate(body.angle);
                    
                    if (body.circleRadius) {
                        // Sphere
                        const gradient = ctx.createRadialGradient(-body.circleRadius/3, -body.circleRadius/3, body.circleRadius/10, 0, 0, body.circleRadius);
                        gradient.addColorStop(0, 'rgba(255,255,255,0.4)');
                        gradient.addColorStop(0.2, 'rgba(255,255,255,0.1)');
                        gradient.addColorStop(1, 'rgba(0,0,0,0.2)');
                        ctx.fillStyle = gradient;
                        ctx.beginPath();
                        ctx.arc(0, 0, body.circleRadius, 0, 2 * Math.PI);
                        ctx.fill();
                    } else {
                        // Box
                        const w = body.bounds.max.x - body.bounds.min.x;
                        const h = body.bounds.max.y - body.bounds.min.y;
                        const gradient = ctx.createLinearGradient(-w/2, -h/2, w/2, h/2);
                        gradient.addColorStop(0, 'rgba(255,255,255,0.3)');
                        gradient.addColorStop(1, 'rgba(0,0,0,0.2)');
                        ctx.fillStyle = gradient;
                        ctx.fillRect(-w/2, -h/2, w, h);
                        
                        // Border is handled by Matter.js render options (strokeStyle), just adding gloss here
                        ctx.fillStyle = 'rgba(255,255,255,0.1)';
                        const inset = Math.min(w, h) * 0.2;
                        if (w > inset*2 && h > inset*2) {
                            ctx.fillRect(-w/2 + inset, -h/2 + inset, w - inset*2, h - inset*2);
                        }
                    }
                    ctx.restore();
                }
            });
            (Render as any).endViewTransform(render);
        } catch (e) {
            console.error("Render Loop Error:", e);
        }
    });

    Render.run(render);
    const runner = Runner.create();
    runnerRef.current = runner;
    Runner.run(runner, engine);

    return () => {
      render.canvas.removeEventListener('wheel', handleWheel);
      Render.stop(render);
      Runner.stop(runner);
      if (render.canvas) render.canvas.remove();
      World.clear(engine.world, false);
      Engine.clear(engine);
    };
  }, [sceneConfig]); 

  // Update Physics (Gravity/Time)
  useEffect(() => {
    if (engineRef.current) {
        // Matter.js defaults: scale=0.001, y=1.
        // If we map 9.81 m/s² (Earth) to Matter's y=1, we must scale inputs by 1/9.81.
        // This ensures Earth is "Normal" speed, and Jupiter (24.79) is ~2.5x Normal speed.
        // We also clamp to prevent crash.
        const GRAVITY_SCALE_FACTOR = 1 / 9.81;
        const normalizedY = physicsState.gravity.y * GRAVITY_SCALE_FACTOR;
        const normalizedX = physicsState.gravity.x * GRAVITY_SCALE_FACTOR;

        engineRef.current.gravity.x = isFinite(normalizedX) ? Math.min(Math.max(normalizedX, -10), 10) : 0;
        engineRef.current.gravity.y = isFinite(normalizedY) ? Math.min(Math.max(normalizedY, -10), 10) : 1;
      
        if (runnerRef.current) {
            engineRef.current.timing.timeScale = physicsState.timeScale;
        }
    }
  }, [physicsState.gravity, physicsState.timeScale]);

  return (
    <div 
      ref={containerRef} 
      className="w-full h-full relative overflow-hidden bg-gradient-to-br from-gray-900 via-gray-900 to-black"
      style={{ touchAction: 'none' }} 
    />
  );
};

export default SimulationCanvas;
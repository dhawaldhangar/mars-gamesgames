import React, { useEffect, useImperativeHandle, useRef, useState } from 'react';
import { Bot, Crosshair, Shield, Sparkles, Sprout, Wind, Zap } from 'lucide-react';
import { ModuleId, SolHazardType } from '../data/campaignArc';
import {
  MissionResources,
  ROVER_POWER_COST_KWH,
  ROVER_ROCK_SCIENCE_PTS,
  SolAtmosphereTargets,
} from '../game/simulation';
import {
  ActiveSystemGlow,
  DonkiSceneTelemetry,
  EmergencyMode,
  EvaPlayerState,
  InteriorPlayerState,
  MarsOutpostScene,
  ProjectedModuleAnchor,
  ProjectedRockAnchor,
  RoverMissionTarget,
  RoverPhase,
  SceneViewMode,
  ScienceBoulderId,
} from '../three/MarsOutpostScene';
import { InteriorInteractableId } from '../game/interiorCollision';
import { EvaInteractableId } from '../game/evaPhysics';

export interface ModulePopup {
  id: number;
  moduleId: ModuleId | ScienceBoulderId;
  text: string;
  positive: boolean;
}

export interface MarsViewportHandle {
  triggerModulePulse: (moduleId: ModuleId) => void;
  deployRover: (target: RoverMissionTarget) => boolean;
  triggerNightCycle: (
    hazardType: SolHazardType,
    shieldBlockedFlare: boolean,
    onComplete: () => void,
    durationSec?: number
  ) => void;
  setViewMode: (mode: SceneViewMode, evaSpawnSource?: 'hud' | 'airlock') => void;
  beginCameraTransitionTo: (
    mode: SceneViewMode,
    onMidpoint: () => void,
    evaSpawnSource?: 'hud' | 'airlock'
  ) => void;
  cancelCameraTransition: () => void;
  setInteriorInputPaused: (paused: boolean) => void;
  unlockInteriorPointer: () => void;
  setVirtualInteriorInput: (input: { forward: number; right: number; turn: number }) => void;
  triggerInteriorFeedback: (id: InteriorInteractableId) => void;
  setEvaInputPaused: (paused: boolean) => void;
  unlockEvaPointer: () => void;
  setVirtualEvaInput: (input: { forward: number; right: number; turn: number }) => void;
}

interface MarsViewportProps {
  resources: MissionResources;
  tau: number;
  targetModule: ModuleId | 'any';
  emergencyMode: EmergencyMode;
  atmosphere: SolAtmosphereTargets;
  hazardType: SolHazardType;
  activeSystemGlow: ActiveSystemGlow;
  donkiTelemetry: DonkiSceneTelemetry;
  speedMultiplier: number;
  isNightCycle: boolean;
  disabled: boolean;
  activePopup: ModulePopup | null;
  roverPhase: RoverPhase;
  analyzedRockIds: ScienceBoulderId[];
  viewMode: SceneViewMode;
  highlightDomeInteriorEntry?: boolean;
  onModuleAction: (moduleId: ModuleId) => void;
  onEnterInterior: () => void;
  onDeployRover: (target: RoverMissionTarget) => void;
  onRoverPhaseChange: (phase: RoverPhase, label: string | null) => void;
  onRoverTaskComplete: (target: RoverMissionTarget) => void;
  onViewModeChange?: (mode: SceneViewMode) => void;
  onInteriorStateUpdate?: (state: InteriorPlayerState) => void;
  onInteriorInteract?: (id: InteriorInteractableId) => void;
  onEvaStateUpdate?: (state: EvaPlayerState) => void;
  onEvaInteract?: (id: EvaInteractableId) => void;
}

const MODULE_META: Record<
  ModuleId,
  {
    name: string;
    actionLabel: string;
    tradeoffShort: string;
    accentClass: string;
    roverTargetLabel?: string;
    icon: React.FC<{ className?: string }>;
  }
> = {
  solar: {
    name: 'Solar Array Field',
    actionLabel: 'Clean Dust',
    tradeoffShort: '+Power · -3% H₂O',
    accentClass: 'border-amber-400/70 text-amber-200 hover:border-amber-300',
    roverTargetLabel: 'Solar Array Field',
    icon: Zap,
  },
  moxie: {
    name: 'MOXIE O₂ Core',
    actionLabel: 'Boost O₂',
    tradeoffShort: '+14% O₂ · -12 kWh',
    accentClass: 'border-cyan-400/70 text-cyan-200 hover:border-cyan-300',
    roverTargetLabel: 'MOXIE Filter Core',
    icon: Wind,
  },
  shelter: {
    name: 'Water-Wall Shelter',
    actionLabel: 'Shield Up',
    tradeoffShort: '+6cm Wall · -14 kWh',
    accentClass: 'border-sky-400/70 text-sky-200 hover:border-sky-300',
    icon: Shield,
  },
  biodome: {
    name: 'Hydroponic Bio-Dome',
    actionLabel: 'Water Crops',
    tradeoffShort: '+8% O₂/Food · -10 kWh',
    accentClass: 'border-emerald-400/70 text-emerald-200 hover:border-emerald-300',
    icon: Sprout,
  },
};

export const MarsViewport = React.forwardRef<MarsViewportHandle, MarsViewportProps>(
  (
    {
      resources,
      tau,
      targetModule,
      emergencyMode,
      atmosphere,
      hazardType,
      activeSystemGlow,
      donkiTelemetry,
      speedMultiplier,
      isNightCycle,
      disabled,
      activePopup,
      roverPhase,
      analyzedRockIds,
      viewMode,
      highlightDomeInteriorEntry = false,
      onModuleAction,
      onEnterInterior,
      onDeployRover,
      onRoverPhaseChange,
      onRoverTaskComplete,
      onViewModeChange,
      onInteriorStateUpdate,
      onInteriorInteract,
      onEvaStateUpdate,
      onEvaInteract,
    },
    ref
  ) => {
    const mountRef = useRef<HTMLDivElement | null>(null);
    const sceneRef = useRef<MarsOutpostScene | null>(null);

    const onActionRef = useRef(onModuleAction);
    onActionRef.current = onModuleAction;

    const onEnterInteriorRef = useRef(onEnterInterior);
    onEnterInteriorRef.current = onEnterInterior;

    const onDeployRoverRef = useRef(onDeployRover);
    onDeployRoverRef.current = onDeployRover;

    const onRoverPhaseChangeRef = useRef(onRoverPhaseChange);
    onRoverPhaseChangeRef.current = onRoverPhaseChange;

    const onRoverTaskCompleteRef = useRef(onRoverTaskComplete);
    onRoverTaskCompleteRef.current = onRoverTaskComplete;

    const onViewModeChangeRef = useRef(onViewModeChange);
    onViewModeChangeRef.current = onViewModeChange;

    const onInteriorStateUpdateRef = useRef(onInteriorStateUpdate);
    onInteriorStateUpdateRef.current = onInteriorStateUpdate;

    const onInteriorInteractRef = useRef(onInteriorInteract);
    onInteriorInteractRef.current = onInteriorInteract;

    const onEvaStateUpdateRef = useRef(onEvaStateUpdate);
    onEvaStateUpdateRef.current = onEvaStateUpdate;

    const onEvaInteractRef = useRef(onEvaInteract);
    onEvaInteractRef.current = onEvaInteract;

    const disabledRef = useRef(disabled || isNightCycle);
    disabledRef.current = disabled || isNightCycle;

    const isNightCycleRef = useRef(isNightCycle);
    isNightCycleRef.current = isNightCycle;

    const [anchors, setAnchors] = useState<ProjectedModuleAnchor[]>([]);
    const [rockAnchors, setRockAnchors] = useState<ProjectedRockAnchor[]>([]);
    const [hoveredId, setHoveredId] = useState<ModuleId | null>(null);
    const [domHoveredId, setDomHoveredId] = useState<ModuleId | null>(null);
    const [hoveredRockId, setHoveredRockId] = useState<ScienceBoulderId | null>(null);
    const [domHoveredRockId, setDomHoveredRockId] = useState<ScienceBoulderId | null>(null);
    const [webglError, setWebglError] = useState<string | null>(null);

    const domHoverTimerRef = useRef<number | null>(null);
    const rockHoverTimerRef = useRef<number | null>(null);

    const pinDomModuleHover = (id: ModuleId | null) => {
      if (domHoverTimerRef.current !== null) {
        window.clearTimeout(domHoverTimerRef.current);
        domHoverTimerRef.current = null;
      }
      if (id) {
        setDomHoveredId(id);
      } else {
        domHoverTimerRef.current = window.setTimeout(() => {
          setDomHoveredId(null);
          domHoverTimerRef.current = null;
        }, 180);
      }
    };

    const pinDomRockHover = (id: ScienceBoulderId | null) => {
      if (rockHoverTimerRef.current !== null) {
        window.clearTimeout(rockHoverTimerRef.current);
        rockHoverTimerRef.current = null;
      }
      if (id) {
        setDomHoveredRockId(id);
      } else {
        rockHoverTimerRef.current = window.setTimeout(() => {
          setDomHoveredRockId(null);
          rockHoverTimerRef.current = null;
        }, 180);
      }
    };

    useEffect(() => {
      return () => {
        if (domHoverTimerRef.current !== null) window.clearTimeout(domHoverTimerRef.current);
        if (rockHoverTimerRef.current !== null) window.clearTimeout(rockHoverTimerRef.current);
      };
    }, []);

    useImperativeHandle(ref, () => ({
      triggerModulePulse: (moduleId: ModuleId) => {
        sceneRef.current?.triggerModuleFeedback(moduleId);
      },
      deployRover: (target: RoverMissionTarget) => {
        return sceneRef.current?.deployRover(target) ?? false;
      },
      triggerNightCycle: (hazardType, shieldBlockedFlare, onComplete, durationSec) => {
        sceneRef.current?.triggerNightCycle(hazardType, shieldBlockedFlare, onComplete, durationSec);
      },
      setViewMode: (mode: SceneViewMode, evaSpawnSource?: 'hud' | 'airlock') => {
        sceneRef.current?.setViewMode(mode, evaSpawnSource);
      },
      beginCameraTransitionTo: (
        mode: SceneViewMode,
        onMidpoint: () => void,
        evaSpawnSource?: 'hud' | 'airlock'
      ) => {
        if (sceneRef.current) {
          sceneRef.current.beginCameraTransitionTo(mode, onMidpoint, evaSpawnSource);
        } else {
          onMidpoint();
        }
      },
      cancelCameraTransition: () => {
        sceneRef.current?.cancelCameraTransition();
      },
      setInteriorInputPaused: (paused: boolean) => {
        sceneRef.current?.setInteriorInputPaused(paused);
      },
      unlockInteriorPointer: () => {
        sceneRef.current?.unlockInteriorPointer();
      },
      setVirtualInteriorInput: (input) => {
        sceneRef.current?.setVirtualInteriorInput(input);
      },
      triggerInteriorFeedback: (id: InteriorInteractableId) => {
        sceneRef.current?.triggerInteriorFeedback(id);
      },
      setEvaInputPaused: (paused: boolean) => {
        sceneRef.current?.setEvaInputPaused(paused);
      },
      unlockEvaPointer: () => {
        sceneRef.current?.unlockEvaPointer();
      },
      setVirtualEvaInput: (input) => {
        sceneRef.current?.setVirtualEvaInput(input);
      },
    }));

    useEffect(() => {
      const el = mountRef.current;
      if (!el) return;

      const controller = new MarsOutpostScene(el, {
        onModuleClick: (moduleId) => {
          if (moduleId === 'shelter') {
            if (!isNightCycleRef.current) {
              onEnterInteriorRef.current();
            }
            return;
          }
          if (!disabledRef.current) {
            onActionRef.current(moduleId);
          }
        },
        onHoverModule: (moduleId) => {
          setHoveredId(moduleId);
        },
        onAnchorsUpdate: (next) => {
          setAnchors(next);
        },
        onRockClick: (rockId, label) => {
          if (!disabledRef.current) {
            onDeployRoverRef.current({ kind: 'rock', rockId, label });
          }
        },
        onHoverRock: (rockId) => {
          setHoveredRockId(rockId);
        },
        onRockAnchorsUpdate: (next) => {
          setRockAnchors(next);
        },
        onRoverPhaseChange: (phase, label) => {
          onRoverPhaseChangeRef.current(phase, label);
        },
        onRoverTaskComplete: (target) => {
          onRoverTaskCompleteRef.current(target);
        },
        onViewModeChange: (mode) => {
          onViewModeChangeRef.current?.(mode);
        },
        onInteriorStateUpdate: (state) => {
          onInteriorStateUpdateRef.current?.(state);
        },
        onInteriorInteract: (id) => {
          onInteriorInteractRef.current?.(id);
        },
        onEvaStateUpdate: (state) => {
          onEvaStateUpdateRef.current?.(state);
        },
        onEvaInteract: (id) => {
          onEvaInteractRef.current?.(id);
        },
        onWebglError: (reason) => {
          setWebglError(reason);
        },
      });
      sceneRef.current = controller;

      return () => {
        controller.dispose();
        sceneRef.current = null;
      };
    }, []);

    useEffect(() => {
      sceneRef.current?.updateMissionVisuals(resources, tau, targetModule, emergencyMode, {
        atmosphere,
        hazardType,
        activeSystemGlow,
        speedMultiplier,
        donki: donkiTelemetry,
      });
    }, [
      resources,
      tau,
      targetModule,
      emergencyMode,
      atmosphere,
      hazardType,
      activeSystemGlow,
      speedMultiplier,
      donkiTelemetry,
    ]);

    const getDynamicStatus = (id: ModuleId): string => {
      if (id === 'solar') return `Dust ${resources.panelDustPct}%`;
      if (id === 'moxie') return `O₂ ${resources.lifeSupportPct}%`;
      if (id === 'shelter') return `Wall ${resources.waterWallCm}cm`;
      return `Crop Lv.${resources.cropGrowth}`;
    };

    const roverBusy = roverPhase !== 'idle';
    const insufficientRoverPower = resources.powerKwh < ROVER_POWER_COST_KWH;

    return (
      <div className="fixed inset-0 overflow-hidden bg-[#1D0F0C]" data-testid="mars-3d-viewport">
        {/* Isolated WebGL Canvas Container */}
        <div ref={mountRef} className="absolute inset-0" />

        {webglError && (
          <div className="absolute inset-0 flex items-center justify-center p-6 bg-[#070B14] text-center">
            <div className="max-w-md bg-[#0F172A] border border-slate-700 rounded-2xl p-6 space-y-2">
              <p className="text-base font-bold text-white">3D Viewport Unavailable</p>
              <p className="text-xs text-slate-300">{webglError}</p>
            </div>
          </div>
        )}

        {/* Projected On-Object 3D Module & Science Boulder Hotspots (Exterior View Only) */}
        {viewMode === 'exterior' && !isNightCycle && !webglError && (
          <div className="absolute inset-0 pointer-events-none z-10">
            {anchors.map((anchor) => {
              if (!anchor.visible) return null;
              const meta = MODULE_META[anchor.id];
              const Icon = meta.icon;
              const isTarget = targetModule === anchor.id;
              const isHovered = hoveredId === anchor.id || domHoveredId === anchor.id;
              const hasPopup = activePopup?.moduleId === anchor.id;
              if (!isHovered && !hasPopup) return null;

              const supportsRover = anchor.id === 'solar' || anchor.id === 'moxie';
              const isMainDome = anchor.id === 'shelter';

              return (
                <div
                  key={anchor.id}
                  onMouseEnter={() => pinDomModuleHover(anchor.id)}
                  onMouseLeave={() => pinDomModuleHover(null)}
                  style={{
                    left: `${anchor.x}px`,
                    top: `${anchor.y}px`,
                  }}
                  className="absolute -translate-x-1/2 -translate-y-full pointer-events-auto flex flex-col items-center gap-1"
                >
                  {/* Floating Action Feedback Callout */}
                  {hasPopup && activePopup && (
                    <div
                      key={activePopup.id}
                      data-testid={`module-feedback-${anchor.id}`}
                      className={`anim-float-pop mb-1 px-2.5 py-1 rounded-lg text-[11px] font-mono font-bold text-center whitespace-nowrap border shadow-lg ${
                        activePopup.positive
                          ? 'bg-[#071F1B] border-emerald-400 text-emerald-200'
                          : 'bg-[#290F14] border-rose-400 text-rose-200'
                      }`}
                    >
                      {activePopup.text}
                    </div>
                  )}

                  {/* Compact status & tradeoff detail chip cleanly above buttons */}
                  {!hasPopup && (
                    <div className="px-2 py-0.5 rounded-md bg-[#0B1220]/95 border border-slate-700/90 text-[10px] font-mono text-slate-200 whitespace-nowrap shadow-lg">
                      <span>{getDynamicStatus(anchor.id)}</span>
                      <span className="text-slate-500 mx-1">·</span>
                      <span className="text-cyan-300">{meta.tradeoffShort}</span>
                    </div>
                  )}

                  {/* Clickable Main Habitat Dome First-Person Entry Label */}
                  {isMainDome && (
                    <button
                      type="button"
                      data-testid="enter-interior-dome-btn"
                      onClick={onEnterInterior}
                      className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg border text-[11px] font-semibold whitespace-nowrap shadow-lg cursor-pointer transition-all duration-150 focus-visible:outline-2 focus-visible:outline-cyan-300 ${
                        highlightDomeInteriorEntry
                          ? 'bg-[#120A22] border-amber-300 text-amber-100 ring-2 ring-cyan-300/75 -translate-y-0.5'
                          : isHovered
                          ? 'bg-[#110B22] border-cyan-300 text-white -translate-y-0.5'
                          : 'bg-[#0B1220]/90 hover:bg-[#140E26] border-cyan-400/80 text-cyan-100 hover:-translate-y-0.5'
                      }`}
                    >
                      <span>🔍 Enter Habitat Interior (First-Person)</span>
                    </button>
                  )}

                  <button
                    type="button"
                    data-testid={`hotspot-${anchor.id}`}
                    disabled={disabled}
                    onClick={() => onModuleAction(anchor.id)}
                    aria-label={`${meta.name}: ${meta.actionLabel} (${getDynamicStatus(anchor.id)} · ${meta.tradeoffShort})`}
                    className={`group relative flex items-center gap-1.5 px-2.5 py-1 rounded-lg border text-left transition-all duration-150 cursor-pointer shadow-md focus-visible:outline-2 focus-visible:outline-cyan-300 ${
                      isHovered
                        ? 'bg-[#0B1220] opacity-100 -translate-y-0.5 border-amber-300 shadow-lg'
                        : isTarget
                        ? 'bg-[#070B14]/70 opacity-80 hover:opacity-100 hover:bg-[#0B1220] focus-visible:opacity-100 focus-visible:bg-[#0B1220] border-cyan-400/85 ring-1 ring-cyan-400/35 hover:-translate-y-0.5'
                        : `bg-[#070B14]/65 opacity-70 hover:opacity-100 hover:bg-[#0B1220] focus-visible:opacity-100 focus-visible:bg-[#0B1220] hover:-translate-y-0.5 ${meta.accentClass}`
                    }`}
                  >
                    <Icon className="w-3 h-3 shrink-0" aria-hidden="true" />
                    <span className="text-[11px] font-semibold tracking-tight text-white whitespace-nowrap">
                      {meta.actionLabel}
                    </span>
                    {isTarget && (
                      <Sparkles className="w-2.5 h-2.5 text-cyan-300 shrink-0" aria-hidden="true" />
                    )}
                  </button>

                  {/* Autonomous Rover External Maintenance Dispatch Option (0 Crew Radiation) */}
                  {supportsRover && (
                    <button
                      type="button"
                      data-testid={`deploy-rover-${anchor.id}`}
                      disabled={disabled || roverBusy || insufficientRoverPower}
                      onClick={() =>
                        onDeployRover({
                          kind: anchor.id as 'solar' | 'moxie',
                          moduleId: anchor.id as 'solar' | 'moxie',
                          label: meta.roverTargetLabel ?? meta.name,
                        })
                      }
                      title="Dispatch autonomous rover with ZERO crew radiation penalty (4s travel + 3s laser work)"
                      className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-[#120A1E]/92 hover:bg-[#1D1132] disabled:opacity-45 disabled:cursor-not-allowed border border-cyan-400/65 text-[10px] font-mono font-semibold text-cyan-200 whitespace-nowrap shadow-md cursor-pointer transition-colors focus-visible:outline-2 focus-visible:outline-cyan-300"
                    >
                      <Bot className="w-2.5 h-2.5 text-fuchsia-300 shrink-0" aria-hidden="true" />
                      <span>Deploy Rover (-{ROVER_POWER_COST_KWH} kWh)</span>
                    </button>
                  )}
                </div>
              );
            })}

            {/* Clickable Science Boulders (Hover-only floating labels) */}
            {rockAnchors.map((rock) => {
              if (!rock.visible) return null;
              const isHovered = hoveredRockId === rock.id || domHoveredRockId === rock.id;
              const isAnalyzed = analyzedRockIds.includes(rock.id);
              const hasPopup = activePopup?.moduleId === rock.id;
              if (!isHovered && !hasPopup) return null;

              return (
                <div
                  key={rock.id}
                  onMouseEnter={() => pinDomRockHover(rock.id)}
                  onMouseLeave={() => pinDomRockHover(null)}
                  style={{
                    left: `${rock.x}px`,
                    top: `${rock.y}px`,
                  }}
                  className="absolute -translate-x-1/2 -translate-y-full pointer-events-auto flex flex-col items-center"
                >
                  {hasPopup && activePopup && (
                    <div
                      key={activePopup.id}
                      data-testid={`rock-feedback-${rock.id}`}
                      className={`anim-float-pop mb-1 px-2 py-0.5 rounded-lg text-[10px] font-mono font-bold text-center whitespace-nowrap border shadow-lg ${
                        activePopup.positive
                          ? 'bg-[#071F1B] border-emerald-400 text-emerald-200'
                          : 'bg-[#290F14] border-rose-400 text-rose-200'
                      }`}
                    >
                      {activePopup.text}
                    </div>
                  )}

                  <button
                    type="button"
                    data-testid={`rock-hotspot-${rock.id}`}
                    disabled={disabled || roverBusy || insufficientRoverPower}
                    onClick={() =>
                      onDeployRover({
                        kind: 'rock',
                        rockId: rock.id,
                        label: rock.label,
                      })
                    }
                    aria-label={`Scan ${rock.label} with Rover (-${ROVER_POWER_COST_KWH} kWh, +${ROVER_ROCK_SCIENCE_PTS} Sci Pts)`}
                    className={`group relative flex items-center gap-1 px-2 py-0.5 rounded-md border text-left transition-all duration-150 cursor-pointer shadow-sm disabled:opacity-50 disabled:cursor-not-allowed focus-visible:outline-2 focus-visible:outline-cyan-300 ${
                      isHovered
                        ? 'bg-[#170E24] opacity-100 -translate-y-0.5 border-amber-300 text-amber-100'
                        : isAnalyzed
                        ? 'bg-[#0B1220]/75 opacity-75 hover:opacity-100 border-emerald-400/65 text-emerald-200'
                        : 'bg-[#100918]/80 opacity-80 hover:opacity-100 border-cyan-400/60 text-cyan-100 hover:-translate-y-0.5'
                    }`}
                  >
                    <Crosshair className="w-2.5 h-2.5 text-cyan-300 shrink-0" aria-hidden="true" />
                    <span className="text-[10px] font-mono font-medium whitespace-nowrap">
                      {rock.label}
                    </span>

                    {!hasPopup && (
                      <span
                        className={`pointer-events-none absolute bottom-full left-1/2 -translate-x-1/2 mb-1 px-2 py-0.5 rounded bg-[#0B1220] border border-slate-700 text-[10px] font-mono text-slate-200 whitespace-nowrap shadow-lg transition-opacity duration-150 ${
                          isHovered
                            ? 'opacity-100'
                            : 'opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100'
                        }`}
                      >
                        Deploy Rover (-{ROVER_POWER_COST_KWH} kWh · +{ROVER_ROCK_SCIENCE_PTS} Sci)
                      </span>
                    )}
                  </button>
                </div>
              );
            })}
          </div>
        )}
      </div>
    );
  }
);

MarsViewport.displayName = 'MarsViewport';


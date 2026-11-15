import React, { useEffect, useRef } from 'react';
import {
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  Compass,
  LogOut,
  RotateCcw,
  RotateCw,
} from 'lucide-react';
import { InteriorInteractableId } from '../game/interiorCollision';
import { InteriorPlayerState } from '../three/MarsOutpostScene';

interface InteriorHudOverlayProps {
  interiorState: InteriorPlayerState;
  statusBanner: { id: number; text: string; positive: boolean } | null;
  moxieCrisisActive: boolean;
  isSol10Highlight: boolean;
  onExitInterior: () => void;
  onTriggerInteract: (id: InteriorInteractableId) => void;
  onVirtualInputChange: (input: { forward: number; right: number; turn: number }) => void;
}

export const InteriorHudOverlay: React.FC<InteriorHudOverlayProps> = ({
  interiorState,
  statusBanner,
  moxieCrisisActive,
  isSol10Highlight,
  onExitInterior,
  onTriggerInteract,
  onVirtualInputChange,
}) => {
  const inputStateRef = useRef({ forward: 0, right: 0, turn: 0 });

  const setAxis = (key: 'forward' | 'right' | 'turn', value: number) => {
    inputStateRef.current = { ...inputStateRef.current, [key]: value };
    onVirtualInputChange(inputStateRef.current);
  };

  useEffect(() => {
    return () => {
      onVirtualInputChange({ forward: 0, right: 0, turn: 0 });
    };
  }, [onVirtualInputChange]);

  const nearest = interiorState.nearestInteractable;

  return (
    <div
      data-testid="interior-hud-overlay"
      className="fixed inset-0 pointer-events-none z-20 select-none"
    >
      {/* Faint peripheral helmet/visor edge vignette (keeps center completely clear) */}
      <div
        aria-hidden="true"
        className="fixed inset-0 pointer-events-none"
        style={{
          background:
            'radial-gradient(ellipse 84% 78% at 50% 50%, rgba(7, 11, 20, 0) 64%, rgba(8, 17, 32, 0.28) 88%, rgba(4, 8, 16, 0.56) 100%)',
        }}
      >
        <div className="absolute top-3 left-3 w-8 h-8 border-t border-l border-cyan-400/20 rounded-tl-xl" />
        <div className="absolute top-3 right-3 w-8 h-8 border-t border-r border-cyan-400/20 rounded-tr-xl" />
        <div className="absolute bottom-3 left-3 w-8 h-8 border-b border-l border-cyan-400/20 rounded-bl-xl" />
        <div className="absolute bottom-3 right-3 w-8 h-8 border-b border-r border-cyan-400/20 rounded-br-xl" />
      </div>

      {/* Top-Left Exit Button & Current Zone Readout (below top telemetry bar) */}
      <div className="fixed top-[104px] sm:top-[100px] left-3 sm:left-4 pointer-events-auto flex flex-col items-start gap-1.5 z-30">
        <button
          type="button"
          data-testid="exit-interior-btn"
          onClick={onExitInterior}
          className="h-[28px] inline-flex items-center gap-1.5 px-2.5 rounded-md bg-[#0F172A]/95 hover:bg-[#1E293B] border border-cyan-400/70 text-xs font-mono font-semibold text-cyan-100 shadow-xl cursor-pointer transition-colors focus-visible:outline-2 focus-visible:outline-cyan-300"
        >
          <LogOut className="w-3.5 h-3.5 text-amber-300 shrink-0" aria-hidden="true" />
          <span>[ESC / Exit to Exterior View]</span>
        </button>

        <div
          data-testid="interior-zone-badge"
          className="px-2.5 py-1.5 rounded-lg bg-[#0B1220]/90 border border-slate-700/90 shadow-lg max-w-[260px]"
        >
          <div className="flex items-center gap-1.5">
            <Compass className="w-3.5 h-3.5 text-cyan-300 shrink-0" aria-hidden="true" />
            <span className="text-[10px] font-mono font-bold tracking-wider uppercase text-cyan-300">
              {interiorState.zone.code}
            </span>
            <span className="text-[11px] font-semibold text-white truncate">
              {interiorState.zone.name}
            </span>
          </div>
          <p className="text-[10px] text-slate-300 mt-0.5 leading-tight">
            {interiorState.zone.subtitle}
          </p>
        </div>

        {isSol10Highlight && (
          <div
            data-testid="sol10-interior-banner"
            className="px-2.5 py-1 rounded-lg bg-[#120A22]/95 border border-amber-400/75 text-[10.5px] font-mono text-amber-200 shadow-lg"
          >
            Sol 10 Command Interior · Inspect MOXIE, Bio-Dome & Rover Terminal
          </div>
        )}

        {moxieCrisisActive && interiorState.zone.id !== 'moxie_bay' && (
          <div className="px-2.5 py-1 rounded-lg bg-[#2A0E14]/95 border border-rose-400/70 text-[10px] font-mono text-rose-200 shadow-lg">
            Alert in West Wing (Zone B): Check MOXIE Bay
          </div>
        )}
      </div>

      {/* Action Status Feedback Banner */}
      {statusBanner && (
        <div
          key={statusBanner.id}
          data-testid="interior-action-feedback"
          className={`fixed top-[104px] sm:top-[100px] left-1/2 -translate-x-1/2 px-3.5 py-1.5 rounded-lg border font-mono text-xs font-bold shadow-xl ${
            statusBanner.positive
              ? 'bg-[#071F1B]/95 border-emerald-400 text-emerald-200'
              : 'bg-[#290F14]/95 border-rose-400 text-rose-200'
          }`}
        >
          {statusBanner.text}
        </div>
      )}

      {/* Center Reticle Crosshair & Dynamic Contextual [E] Prompt */}
      <div className="fixed inset-0 flex flex-col items-center justify-center pointer-events-none">
        <div
          aria-hidden="true"
          className={`w-3.5 h-3.5 rounded-full border transition-all duration-150 ${
            nearest
              ? 'border-cyan-300 scale-125 bg-cyan-300/30'
              : 'border-white/55 bg-white/15'
          }`}
        />

        {nearest && (
          <button
            type="button"
            data-testid="interior-interact-prompt"
            onClick={() => onTriggerInteract(nearest.id)}
            className="mt-4 pointer-events-auto px-3.5 py-1.5 rounded-lg bg-[#0B1220]/95 hover:bg-[#172136] border border-cyan-400 text-xs font-mono font-semibold text-cyan-100 shadow-2xl cursor-pointer transition-colors focus-visible:outline-2 focus-visible:outline-cyan-300"
          >
            {nearest.promptLabel}
          </button>
        )}
      </div>

      {/* Bottom Controls Hint + Mobile/Click Fallback Navigation Arrows */}
      <div className="fixed bottom-3 right-3 sm:bottom-3.5 sm:right-4 pointer-events-auto flex flex-col items-end gap-1.5 z-30">
        <div
          data-testid="bottom-control-legend"
          className="px-2.5 py-1 rounded-md bg-[#0B1220]/90 border border-slate-700/80 shadow-lg text-[10px] sm:text-[10.5px] font-mono text-slate-200 whitespace-nowrap"
        >
          [WASD] Move • [Mouse] Look • [E] {interiorState.pointerLocked ? 'Interact • [ESC] Unlock' : 'Interact • [ESC] Orbital View'}
        </div>

        <div
          data-testid="interior-touch-controls"
          className="grid grid-cols-3 gap-1 p-1.5 rounded-xl bg-[#0B1220]/92 border border-slate-700/90 shadow-xl"
        >
          <button
            type="button"
            data-testid="fp-turn-left"
            aria-label="Look Left"
            onPointerDown={() => setAxis('turn', -1)}
            onPointerUp={() => setAxis('turn', 0)}
            onPointerLeave={() => setAxis('turn', 0)}
            className="w-8 h-8 rounded-md bg-[#162033] hover:bg-[#1E2B44] border border-slate-600/80 flex items-center justify-center text-cyan-200 cursor-pointer"
          >
            <RotateCcw className="w-3.5 h-3.5" aria-hidden="true" />
          </button>
          <button
            type="button"
            data-testid="fp-move-forward"
            aria-label="Move Forward"
            onPointerDown={() => setAxis('forward', 1)}
            onPointerUp={() => setAxis('forward', 0)}
            onPointerLeave={() => setAxis('forward', 0)}
            className="w-8 h-8 rounded-md bg-[#162033] hover:bg-[#1E2B44] border border-cyan-500/50 flex items-center justify-center text-white cursor-pointer"
          >
            <ArrowUp className="w-4 h-4" aria-hidden="true" />
          </button>
          <button
            type="button"
            data-testid="fp-turn-right"
            aria-label="Look Right"
            onPointerDown={() => setAxis('turn', 1)}
            onPointerUp={() => setAxis('turn', 0)}
            onPointerLeave={() => setAxis('turn', 0)}
            className="w-8 h-8 rounded-md bg-[#162033] hover:bg-[#1E2B44] border border-slate-600/80 flex items-center justify-center text-cyan-200 cursor-pointer"
          >
            <RotateCw className="w-3.5 h-3.5" aria-hidden="true" />
          </button>

          <button
            type="button"
            data-testid="fp-move-left"
            aria-label="Strafe Left"
            onPointerDown={() => setAxis('right', -1)}
            onPointerUp={() => setAxis('right', 0)}
            onPointerLeave={() => setAxis('right', 0)}
            className="w-8 h-8 rounded-md bg-[#162033] hover:bg-[#1E2B44] border border-cyan-500/50 flex items-center justify-center text-white cursor-pointer"
          >
            <ArrowLeft className="w-4 h-4" aria-hidden="true" />
          </button>
          <button
            type="button"
            data-testid="fp-move-back"
            aria-label="Move Backward"
            onPointerDown={() => setAxis('forward', -1)}
            onPointerUp={() => setAxis('forward', 0)}
            onPointerLeave={() => setAxis('forward', 0)}
            className="w-8 h-8 rounded-md bg-[#162033] hover:bg-[#1E2B44] border border-cyan-500/50 flex items-center justify-center text-white cursor-pointer"
          >
            <ArrowDown className="w-4 h-4" aria-hidden="true" />
          </button>
          <button
            type="button"
            data-testid="fp-move-right"
            aria-label="Strafe Right"
            onPointerDown={() => setAxis('right', 1)}
            onPointerUp={() => setAxis('right', 0)}
            onPointerLeave={() => setAxis('right', 0)}
            className="w-8 h-8 rounded-md bg-[#162033] hover:bg-[#1E2B44] border border-cyan-500/50 flex items-center justify-center text-white cursor-pointer"
          >
            <ArrowRight className="w-4 h-4" aria-hidden="true" />
          </button>
        </div>
      </div>
    </div>
  );
};

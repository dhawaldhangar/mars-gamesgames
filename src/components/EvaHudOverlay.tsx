import React, { useEffect, useRef } from 'react';
import {
  AlertTriangle,
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  Home,
  LogOut,
  Radiation,
  RotateCcw,
  RotateCw,
  ThermometerSnowflake,
  Wind,
} from 'lucide-react';
import { EvaInteractableId } from '../game/evaPhysics';
import { EvaPlayerState } from '../three/MarsOutpostScene';

interface EvaHudOverlayProps {
  evaState: EvaPlayerState;
  suitO2Pct: number;
  externalTempC: number;
  radiationDoseCsv: number;
  flareActive: boolean;
  dustSquallActive: boolean;
  flareClassType: string;
  tauValue: number;
  statusBanner: { id: number; text: string; positive: boolean } | null;
  onExitToOrbital: () => void;
  onEnterHabitat: () => void;
  onTriggerInteract: (id: EvaInteractableId) => void;
  onVirtualInputChange: (input: { forward: number; right: number; turn: number }) => void;
}

export const EvaHudOverlay: React.FC<EvaHudOverlayProps> = ({
  evaState,
  suitO2Pct,
  externalTempC,
  radiationDoseCsv,
  flareActive,
  dustSquallActive,
  flareClassType,
  tauValue,
  statusBanner,
  onExitToOrbital,
  onEnterHabitat,
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

  const nearest = evaState.nearestInteractable;
  const o2Rounded = Math.round(suitO2Pct);
  const o2Low = o2Rounded < 35;

  return (
    <div
      data-testid="eva-hud-overlay"
      className="fixed inset-0 pointer-events-none z-20 select-none"
    >
      {/* Subtle Translucent EVA Helmet Visor Frame (zero backdrop-filter over WebGL canvas) */}
      <div
        aria-hidden="true"
        className="fixed inset-0 pointer-events-none"
        style={{
          background: flareActive
            ? 'radial-gradient(ellipse 84% 78% at 50% 50%, rgba(25, 8, 18, 0) 62%, rgba(92, 20, 38, 0.24) 87%, rgba(18, 5, 10, 0.62) 100%)'
            : dustSquallActive
            ? 'radial-gradient(ellipse 84% 78% at 50% 50%, rgba(30, 16, 8, 0) 62%, rgba(110, 52, 24, 0.24) 87%, rgba(16, 8, 4, 0.62) 100%)'
            : 'radial-gradient(ellipse 84% 78% at 50% 50%, rgba(7, 11, 20, 0) 63%, rgba(10, 26, 46, 0.22) 88%, rgba(4, 9, 18, 0.6) 100%)',
        }}
      >
        {/* Curved Helmet Visor Arc SVG Rim */}
        <svg
          viewBox="0 0 1440 900"
          preserveAspectRatio="none"
          className="absolute inset-0 w-full h-full opacity-55"
        >
          <path
            d="M 38 140 Q 22 450 38 760"
            fill="none"
            stroke="rgba(56, 189, 248, 0.26)"
            strokeWidth="2.5"
          />
          <path
            d="M 1402 140 Q 1418 450 1402 760"
            fill="none"
            stroke="rgba(56, 189, 248, 0.26)"
            strokeWidth="2.5"
          />
          <path
            d="M 110 872 Q 720 892 1330 872"
            fill="none"
            stroke="rgba(56, 189, 248, 0.2)"
            strokeWidth="2"
          />
        </svg>
        <div className="absolute top-3 left-3 w-10 h-10 border-t-2 border-l-2 border-cyan-300/30 rounded-tl-3xl" />
        <div className="absolute top-3 right-3 w-10 h-10 border-t-2 border-r-2 border-cyan-300/30 rounded-tr-3xl" />
        <div className="absolute bottom-3 left-3 w-10 h-10 border-b-2 border-l-2 border-cyan-300/30 rounded-bl-3xl" />
        <div className="absolute bottom-3 right-3 w-10 h-10 border-b-2 border-r-2 border-cyan-300/30 rounded-br-3xl" />
      </div>

      {/* Top-Left EVA Mode Exit Controls & Helmet Visor Suit Telemetry */}
      <div className="fixed top-[104px] sm:top-[100px] left-3 sm:left-4 pointer-events-auto flex flex-col items-start gap-1.5 z-30">
        <div className="flex flex-wrap items-center gap-1.5">
          <button
            type="button"
            data-testid="exit-eva-btn"
            onClick={onExitToOrbital}
            className="h-[28px] inline-flex items-center gap-1.5 px-2.5 rounded-md bg-[#0F172A]/95 hover:bg-[#1E293B] border border-cyan-400/75 text-xs font-mono font-semibold text-cyan-100 shadow-xl cursor-pointer transition-colors focus-visible:outline-2 focus-visible:outline-cyan-300"
          >
            <LogOut className="w-3.5 h-3.5 text-amber-300 shrink-0" aria-hidden="true" />
            <span>[ESC / Orbital View]</span>
          </button>

          <button
            type="button"
            data-testid="eva-enter-hab-btn"
            onClick={onEnterHabitat}
            className="h-[28px] inline-flex items-center gap-1.5 px-2.5 rounded-md bg-[#0B1220]/95 hover:bg-[#162B47] border border-slate-600/80 text-xs font-mono font-semibold text-slate-100 shadow-lg cursor-pointer transition-colors focus-visible:outline-2 focus-visible:outline-cyan-300"
          >
            <Home className="w-3.5 h-3.5 text-cyan-300 shrink-0" aria-hidden="true" />
            <span>Enter Hab</span>
          </button>
        </div>

        {/* Helmet Visor Suit Telemetry Panel */}
        <div
          data-testid="eva-visor-telemetry"
          className="h-[28px] px-3 rounded-md bg-[#070B14]/90 border border-cyan-400/40 shadow-lg flex items-center gap-x-3 text-[11px] font-mono whitespace-nowrap"
        >
          <span className="text-[10px] font-bold tracking-wider uppercase text-cyan-300">
            EVA SUIT VISOR
          </span>
          <span className="inline-flex items-center gap-1 whitespace-nowrap">
            <Wind
              className={`w-3 h-3 shrink-0 ${o2Low ? 'text-rose-400' : 'text-cyan-300'}`}
              aria-hidden="true"
            />
            <span className="text-slate-300">Suit O₂:</span>
            <strong
              data-testid="eva-suit-o2"
              className={`tabular-nums ${o2Low ? 'text-rose-300' : 'text-white'}`}
            >
              {o2Rounded}%
            </strong>
          </span>

          <span className="inline-flex items-center gap-1 whitespace-nowrap">
            <ThermometerSnowflake className="w-3 h-3 text-sky-300 shrink-0" aria-hidden="true" />
            <span className="text-slate-300">Ext:</span>
            <strong data-testid="eva-ext-temp" className="text-sky-200 tabular-nums">
              {externalTempC}°C
            </strong>
          </span>

          <span className="inline-flex items-center gap-1 whitespace-nowrap">
            <Radiation
              className={`w-3 h-3 shrink-0 ${flareActive ? 'text-rose-400' : 'text-amber-300'}`}
              aria-hidden="true"
            />
            <strong className="text-slate-100 tabular-nums">
              {radiationDoseCsv.toFixed(2)} cSv
            </strong>
          </span>
        </div>

        {/* Dynamic Radiation & Dust Squall Hazard Warning inside Visor */}
        {(flareActive || dustSquallActive) && (
          <div
            data-testid="eva-hazard-warning"
            className={`min-h-[26px] px-2.5 py-1 rounded-md border text-[10.5px] font-mono font-bold shadow-lg flex items-center gap-1.5 leading-none ${
              flareActive
                ? 'bg-[#2A0B14]/94 border-rose-400/80 text-rose-200'
                : 'bg-[#281508]/94 border-amber-400/80 text-amber-200'
            }`}
          >
            <AlertTriangle className="w-3.5 h-3.5 shrink-0 text-amber-300" aria-hidden="true" />
            <span>
              {flareActive && dustSquallActive
                ? `RADIATION ALERT (${flareClassType}) + DUST SQUALL (Tau ${tauValue.toFixed(2)})`
                : flareActive
                ? `SOLAR FLARE RADIATION WARNING (${flareClassType}) · Seek Habitat Shield`
                : `MARTIAN DUST SQUALL (Tau ${tauValue.toFixed(2)}) · Visor Dust Filter Active`}
            </span>
          </div>
        )}
      </div>

      {/* Action Status Feedback Banner */}
      {statusBanner && (
        <div
          key={statusBanner.id}
          data-testid="eva-action-feedback"
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
            data-testid="eva-interact-prompt"
            onClick={() => onTriggerInteract(nearest.id)}
            className="mt-4 pointer-events-auto px-3.5 py-1.5 rounded-lg bg-[#0B1220]/95 hover:bg-[#172136] border border-cyan-400 text-xs font-mono font-semibold text-cyan-100 shadow-2xl cursor-pointer transition-colors focus-visible:outline-2 focus-visible:outline-cyan-300"
          >
            {nearest.promptLabel}
          </button>
        )}
      </div>

      {/* Bottom Controls Hint + Touch / Click Navigation Pad */}
      <div className="fixed bottom-3 right-3 sm:bottom-3.5 sm:right-4 pointer-events-auto flex flex-col items-end gap-1.5 z-30">
        <div
          data-testid="bottom-control-legend"
          className="px-2.5 py-1 rounded-md bg-[#0B1220]/90 border border-slate-700/80 shadow-lg text-[10px] sm:text-[10.5px] font-mono text-slate-200 whitespace-nowrap"
        >
          [WASD] Move • [Mouse] Look • [E] {evaState.pointerLocked ? 'Service • [ESC] Unlock' : 'Service • [ESC] Orbital View'}
        </div>

        <div
          data-testid="eva-touch-controls"
          className="grid grid-cols-3 gap-1 p-1.5 rounded-xl bg-[#0B1220]/92 border border-slate-700/90 shadow-xl"
        >
          <button
            type="button"
            data-testid="eva-turn-left"
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
            data-testid="eva-move-forward"
            aria-label="Walk Forward"
            onPointerDown={() => setAxis('forward', 1)}
            onPointerUp={() => setAxis('forward', 0)}
            onPointerLeave={() => setAxis('forward', 0)}
            className="w-8 h-8 rounded-md bg-[#162033] hover:bg-[#1E2B44] border border-cyan-500/50 flex items-center justify-center text-white cursor-pointer"
          >
            <ArrowUp className="w-4 h-4" aria-hidden="true" />
          </button>
          <button
            type="button"
            data-testid="eva-turn-right"
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
            data-testid="eva-move-left"
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
            data-testid="eva-move-back"
            aria-label="Walk Backward"
            onPointerDown={() => setAxis('forward', -1)}
            onPointerUp={() => setAxis('forward', 0)}
            onPointerLeave={() => setAxis('forward', 0)}
            className="w-8 h-8 rounded-md bg-[#162033] hover:bg-[#1E2B44] border border-cyan-500/50 flex items-center justify-center text-white cursor-pointer"
          >
            <ArrowDown className="w-4 h-4" aria-hidden="true" />
          </button>
          <button
            type="button"
            data-testid="eva-move-right"
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

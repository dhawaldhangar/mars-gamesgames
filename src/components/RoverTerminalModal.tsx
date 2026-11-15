import React, { useState } from 'react';
import {
  Bot,
  Camera,
  Crosshair,
  Loader2,
  RefreshCw,
  ShieldCheck,
  Wind,
  Wrench,
  X,
} from 'lucide-react';
import { ROVER_POWER_COST_KWH, ROVER_ROCK_SCIENCE_PTS } from '../game/simulation';
import { RoverMissionTarget, RoverPhase, ScienceBoulderId } from '../three/MarsOutpostScene';
import { RoverCameraPhoto } from '../utils/nasaApi';
import roverCamRegeneratedImg from '../assets/images/regenerated_image_1794686128270.jpg';

interface RoverTerminalModalProps {
  currentSol: number;
  powerKwh: number;
  roverPhase: RoverPhase;
  targetLabel: string | null;
  photo: RoverCameraPhoto | null;
  photoHistory: RoverCameraPhoto[];
  loading: boolean;
  canDeploy: boolean;
  analyzedRockIds: ScienceBoulderId[];
  onClose: () => void;
  onDeployRover: (target: RoverMissionTarget) => void;
  onSelectPhoto: (photo: RoverCameraPhoto) => void;
  onRefreshFeed: () => void;
}

const ROCK_TARGETS: Array<{ id: ScienceBoulderId; label: string }> = [
  { id: 'rock-delta', label: 'Delta Mudstone' },
  { id: 'rock-olivine', label: 'Olivine Basalt' },
  { id: 'rock-carbonate', label: 'Carbonate Outcrop' },
  { id: 'rock-sulfate', label: 'Sulfate Vein' },
];

export const RoverTerminalModal: React.FC<RoverTerminalModalProps> = ({
  currentSol,
  powerKwh,
  roverPhase,
  targetLabel,
  photo,
  photoHistory,
  loading,
  canDeploy,
  analyzedRockIds,
  onClose,
  onDeployRover,
  onSelectPhoto,
  onRefreshFeed,
}) => {
  const [imgFailed, setImgFailed] = useState(false);

  const isRoverActive = roverPhase !== 'idle';
  const insufficientPower = powerKwh < ROVER_POWER_COST_KWH;
  const deployDisabled = !canDeploy || isRoverActive || insufficientPower;

  const displaySrc =
    photo && !imgFailed && photo.sourceMode !== 'SYNTHETIC_FALLBACK'
      ? photo.imgSrc
      : roverCamRegeneratedImg;

  return (
    <div
      data-testid="rover-terminal-modal"
      role="dialog"
      aria-modal="true"
      aria-label="Habitat Rover Control Terminal"
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/75"
    >
      <div className="w-full max-w-2xl rounded-2xl bg-[#100918] border border-cyan-400/60 shadow-2xl overflow-hidden text-slate-100">
        {/* Terminal Header */}
        <div className="flex items-center justify-between gap-3 px-4 py-3 bg-[#170D24] border-b border-fuchsia-400/25">
          <div className="flex items-center gap-2 min-w-0">
            <Bot className="w-4 h-4 text-cyan-300 shrink-0" aria-hidden="true" />
            <div>
              <h2 className="text-sm font-bold tracking-tight text-white">
                Zone A · Rover Control Terminal (FHAZ Link)
              </h2>
              <p className="text-[10.5px] font-mono text-cyan-200">
                Remote Exterior Operations · 0.00 cSv Crew Radiation · Power: {powerKwh} kWh
              </p>
            </div>
          </div>
          <button
            type="button"
            data-testid="close-rover-terminal-btn"
            onClick={onClose}
            aria-label="Close Rover Terminal"
            className="p-1.5 rounded-lg bg-[#221436] hover:bg-[#2F1B4A] border border-slate-600 text-slate-200 cursor-pointer"
          >
            <X className="w-4 h-4" aria-hidden="true" />
          </button>
        </div>

        {/* Main Body: Left FHAZ Photo Feed, Right Remote Dispatch Controls */}
        <div className="p-4 grid grid-cols-1 md:grid-cols-2 gap-4">
          {/* Left: NASA Perseverance FHAZ Feed */}
          <div className="space-y-2">
            <div className="flex items-center justify-between text-[11px] font-mono">
              <span className="inline-flex items-center gap-1.5 text-cyan-200 font-semibold">
                <Camera className="w-3.5 h-3.5 text-cyan-300" aria-hidden="true" />
                <span>Perseverance FRONT_HAZCAM_LEFT_A</span>
              </span>
              <button
                type="button"
                onClick={onRefreshFeed}
                className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-[#1B102C] hover:bg-[#27173F] border border-cyan-400/40 text-[10px] text-cyan-200 cursor-pointer"
              >
                <RefreshCw className="w-2.5 h-2.5" aria-hidden="true" />
                <span>Sync Sol {currentSol}</span>
              </button>
            </div>

            <div className="relative aspect-[16/10] w-full rounded-xl overflow-hidden bg-[#070B14] border border-cyan-500/40">
              <img
                data-testid="rover-terminal-image"
                src={displaySrc}
                alt={`NASA Perseverance FHAZ image for Sol ${photo?.sol ?? currentSol}`}
                referrerPolicy="no-referrer"
                onError={() => setImgFailed(true)}
                className="w-full h-full object-cover grayscale contrast-125"
              />
              <div className="pointer-events-none absolute inset-0 rover-fhaz-scanlines opacity-75" />
              {loading && (
                <div className="absolute inset-0 bg-[#070B14]/75 flex items-center justify-center gap-1.5 text-xs font-mono text-cyan-200">
                  <Loader2 className="w-4 h-4 animate-spin text-cyan-300" aria-hidden="true" />
                  <span>Downlinking FHAZ...</span>
                </div>
              )}
              <div className="pointer-events-none absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/90 via-black/50 to-transparent px-2.5 py-1.5 flex items-center justify-between text-[10px] font-mono">
                <span className="text-cyan-200">
                  {photo ? photo.cameraName : 'FRONT_HAZCAM_LEFT_A'}
                </span>
                <span className="text-slate-200">
                  {photo ? `${photo.earthDate} · Sol ${photo.sol}` : `Sol ${currentSol}`}
                </span>
              </div>
            </div>

            {photoHistory.length > 1 && (
              <div className="grid grid-cols-4 gap-1.5">
                {photoHistory.slice(0, 4).map((item, idx) => (
                  <button
                    key={`${item.id}-${idx}`}
                    type="button"
                    onClick={() => {
                      setImgFailed(false);
                      onSelectPhoto(item);
                    }}
                    className={`relative aspect-[16/9] rounded-md overflow-hidden border cursor-pointer ${
                      photo?.id === item.id
                        ? 'border-cyan-300 ring-1 ring-cyan-400/70'
                        : 'border-slate-700 opacity-75 hover:opacity-100'
                    }`}
                  >
                    <img
                      src={item.imgSrc}
                      alt={`Sol ${item.sol} FHAZ capture ${idx + 1}`}
                      referrerPolicy="no-referrer"
                      className="w-full h-full object-cover grayscale contrast-125"
                    />
                  </button>
                ))}
              </div>
            )}

            <div className="rounded-lg bg-[#090612] border border-fuchsia-400/25 px-2.5 py-1.5 text-[10px] font-mono text-cyan-200 text-center">
              {isRoverActive
                ? 'AUTONAV: ACTIVE | SPEED: 4.2 cm/s | MMRTG: 110W'
                : 'AUTONAV: STANDBY | SPEED: 0.0 cm/s | MMRTG: 110W'}
            </div>
          </div>

          {/* Right: Exterior Maintenance & Rock Spectroscopy Dispatch */}
          <div className="space-y-3">
            <div className="rounded-xl bg-[#160D24] border border-slate-700/80 p-3 space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-[11px] font-mono font-semibold uppercase tracking-wider text-slate-300">
                  Exterior Rover Status
                </span>
                <span
                  className={`text-[11px] font-mono font-bold ${
                    isRoverActive ? 'text-amber-300' : 'text-emerald-300'
                  }`}
                >
                  {isRoverActive
                    ? `${roverPhase.toUpperCase()} · ${targetLabel ?? ''}`
                    : 'DOCKED · READY'}
                </span>
              </div>

              <div className="grid grid-cols-1 gap-2 pt-1">
                <button
                  type="button"
                  data-testid="terminal-deploy-solar"
                  disabled={deployDisabled}
                  onClick={() =>
                    onDeployRover({
                      kind: 'solar',
                      moduleId: 'solar',
                      label: 'Solar Array Field',
                    })
                  }
                  className="flex items-center justify-between px-3 py-2 rounded-lg bg-[#1D1230] hover:bg-[#291944] disabled:opacity-45 disabled:cursor-not-allowed border border-cyan-400/50 text-xs font-semibold text-white cursor-pointer"
                >
                  <span className="inline-flex items-center gap-2">
                    <Wrench className="w-3.5 h-3.5 text-amber-300" aria-hidden="true" />
                    <span>Clean Solar Array Dust</span>
                  </span>
                  <span className="font-mono text-[11px] text-cyan-200">
                    -{ROVER_POWER_COST_KWH} kWh
                  </span>
                </button>

                <button
                  type="button"
                  data-testid="terminal-deploy-moxie"
                  disabled={deployDisabled}
                  onClick={() =>
                    onDeployRover({
                      kind: 'moxie',
                      moduleId: 'moxie',
                      label: 'MOXIE Filter Core',
                    })
                  }
                  className="flex items-center justify-between px-3 py-2 rounded-lg bg-[#1D1230] hover:bg-[#291944] disabled:opacity-45 disabled:cursor-not-allowed border border-cyan-400/50 text-xs font-semibold text-white cursor-pointer"
                >
                  <span className="inline-flex items-center gap-2">
                    <Wind className="w-3.5 h-3.5 text-cyan-300" aria-hidden="true" />
                    <span>Fix Exterior MOXIE Filter</span>
                  </span>
                  <span className="font-mono text-[11px] text-cyan-200">
                    -{ROVER_POWER_COST_KWH} kWh
                  </span>
                </button>
              </div>
            </div>

            <div className="rounded-xl bg-[#160D24] border border-slate-700/80 p-3 space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-[11px] font-mono font-semibold uppercase tracking-wider text-slate-300">
                  Jezero Rock Scans (+{ROVER_ROCK_SCIENCE_PTS} Sci Pts)
                </span>
                <span className="inline-flex items-center gap-1 text-[10px] font-mono text-emerald-300">
                  <ShieldCheck className="w-3 h-3" aria-hidden="true" />
                  <span>0 Rad</span>
                </span>
              </div>
              <div className="grid grid-cols-2 gap-1.5">
                {ROCK_TARGETS.map((rock) => {
                  const done = analyzedRockIds.includes(rock.id);
                  return (
                    <button
                      key={rock.id}
                      type="button"
                      data-testid={`terminal-deploy-${rock.id}`}
                      disabled={deployDisabled}
                      onClick={() =>
                        onDeployRover({
                          kind: 'rock',
                          rockId: rock.id,
                          label: rock.label,
                        })
                      }
                      className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border text-[11px] font-mono cursor-pointer disabled:opacity-45 disabled:cursor-not-allowed ${
                        done
                          ? 'bg-[#0B221D] border-emerald-400/60 text-emerald-200'
                          : 'bg-[#1D1230] hover:bg-[#291944] border-cyan-400/45 text-cyan-100'
                      }`}
                    >
                      <Crosshair className="w-3 h-3 text-cyan-300 shrink-0" aria-hidden="true" />
                      <span className="truncate">{rock.label}</span>
                    </button>
                  );
                })}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

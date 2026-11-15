import React from 'react';
import { Activity, Database, Flame, Radio, Shield, Sun, X, Zap } from 'lucide-react';
import { DonkiFetchResult, DonkiSpaceWeatherVisualState } from '../utils/nasaApi';
import { missionAudio } from '../utils/audio';

interface DonkiInspectorCardProps {
  open: boolean;
  donkiResult: DonkiFetchResult;
  weatherState: DonkiSpaceWeatherVisualState;
  waterWallCm: number;
  shieldActive: boolean;
  unlockedCount: number;
  onToggleSimulateXFlare: () => void;
  onOpenArchive: () => void;
  onClose: () => void;
}

export const DonkiInspectorCard: React.FC<DonkiInspectorCardProps> = ({
  open,
  donkiResult,
  weatherState,
  waterWallCm,
  shieldActive,
  unlockedCount,
  onToggleSimulateXFlare,
  onOpenArchive,
  onClose,
}) => {
  if (!open) return null;

  const { level, flare, cme, isSimulatedXFlare } = weatherState;

  const modeBadge = isSimulatedXFlare
    ? {
        label: 'SIMULATED X-FLARE',
        cls: 'bg-rose-950/90 border-rose-500/80 text-rose-200',
      }
    : donkiResult.mode === 'LIVE_NASA_DONKI'
    ? {
        label: 'LIVE NASA API',
        cls: 'bg-emerald-950/90 border-emerald-400/75 text-emerald-200',
      }
    : {
        label: 'VERIFIED ARCHIVE',
        cls: 'bg-amber-950/90 border-amber-400/75 text-amber-200',
      };

  const skyShaderEffect =
    level === 'x_class'
      ? 'Red-Alert crimson sky & fog, pulsing rim-light, interior flicker, and atmospheric particle streaks'
      : level === 'm_class'
      ? 'Amber-violet sky & fog shift, faint upper-sky auroral ribbons, and HUD EM scanlines'
      : 'Quiet Martian butterscotch sky (#d97b54) with crisp directional solar shadows';

  const radiationSummary =
    level === 'x_class'
      ? `+${flare.radBoostMsv} mSv/Sol severe proton & CME surge`
      : level === 'm_class'
      ? `+${flare.radBoostMsv} mSv/Sol elevated solar proton stream`
      : `+${flare.radBoostMsv} mSv/Sol nominal solar background`;

  const shieldSummary = shieldActive
    ? `${waterWallCm}cm Water-Wall active — cyan hexagonal dome deflecting incoming radiation streaks`
    : `${waterWallCm}cm Water-Wall thin — click "Shield Up" on the habitat dome to engage hexagonal deflection`;

  return (
    <aside
      data-testid="donki-inspector-card"
      aria-label="Live NASA DONKI Feed"
      className={`fixed top-[134px] sm:top-[128px] right-2.5 sm:right-5 z-30 w-[min(26.5rem,calc(100vw-1.25rem))] rounded-2xl p-4 bg-[#070B14]/96 border shadow-2xl space-y-3 transition-colors ${
        level === 'x_class'
          ? 'border-rose-500/85 shadow-[0_0_28px_rgba(244,63,94,0.28)]'
          : level === 'm_class'
          ? 'border-fuchsia-400/70 shadow-[0_0_24px_rgba(192,132,252,0.18)]'
          : 'border-cyan-500/50'
      }`}
    >
      {/* Header */}
      <div className="flex items-start justify-between gap-2 pb-2.5 border-b border-slate-800">
        <div className="min-w-0">
          <div className="flex items-center gap-1.5">
            <Sun
              className={`w-4 h-4 shrink-0 ${
                level === 'x_class'
                  ? 'text-rose-400'
                  : level === 'm_class'
                  ? 'text-amber-300'
                  : 'text-cyan-400'
              }`}
              aria-hidden="true"
            />
            <h2 className="text-sm font-bold text-white tracking-tight">Live NASA DONKI Feed</h2>
          </div>
          <p className="text-[11px] font-mono text-slate-400 mt-0.5 whitespace-nowrap">
            NASA CCMC · Synced {donkiResult.fetchedAt}
          </p>
        </div>

        <div className="flex items-center gap-1.5 shrink-0">
          <span
            data-testid="donki-mode-badge"
            className={`px-2 py-0.5 rounded-md border text-[10px] font-mono font-bold whitespace-nowrap ${modeBadge.cls}`}
          >
            {modeBadge.label}
          </span>
          <button
            type="button"
            aria-label="Close Live NASA DONKI Feed"
            onClick={() => {
              missionAudio.playClick();
              onClose();
            }}
            className="p-1 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800 cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* Real-World Event Metadata */}
      <div className="grid grid-cols-2 gap-2 text-xs">
        <div className="bg-[#0B1220] border border-slate-800 rounded-xl px-2.5 py-2">
          <p className="text-[10px] font-mono uppercase text-slate-400">DONKI Event ID</p>
          <p
            data-testid="donki-event-id"
            className="font-mono font-semibold text-cyan-200 text-[10px] leading-tight mt-0.5 whitespace-nowrap"
            title={flare.id}
          >
            {flare.id}
          </p>
        </div>

        <div className="bg-[#0B1220] border border-slate-800 rounded-xl px-2.5 py-2">
          <p className="text-[10px] font-mono uppercase text-slate-400">Peak Timestamp</p>
          <p
            data-testid="donki-peak-time"
            className="font-mono font-semibold text-slate-100 text-[11px] mt-0.5 truncate"
          >
            {flare.peakTime}
          </p>
        </div>

        <div className="bg-[#0B1220] border border-slate-800 rounded-xl px-2.5 py-2">
          <p className="text-[10px] font-mono uppercase text-slate-400">Flare Class</p>
          <p
            data-testid="donki-flare-class"
            className={`font-mono font-bold text-xs mt-0.5 ${
              level === 'x_class'
                ? 'text-rose-300'
                : level === 'm_class'
                ? 'text-amber-300'
                : 'text-emerald-300'
            }`}
          >
            {flare.classType} · {flare.activeRegion}
          </p>
        </div>

        <div className="bg-[#0B1220] border border-slate-800 rounded-xl px-2.5 py-2">
          <p className="text-[10px] font-mono uppercase text-slate-400">CME Activity</p>
          <p className="font-mono font-semibold text-slate-200 text-[11px] mt-0.5 truncate">
            {cme.count} tracked{cme.latestSpeedKms ? ` · ${cme.latestSpeedKms} km/s` : ''}
          </p>
        </div>
      </div>

      {/* Live 3D Atmosphere & Shield Modifier */}
      <div className="bg-[#0B1220] border border-slate-800 rounded-xl p-3 space-y-2 text-xs">
        <div className="flex items-start gap-2">
          <Activity
            className={`w-3.5 h-3.5 shrink-0 mt-0.5 ${
              level === 'x_class'
                ? 'text-rose-400'
                : level === 'm_class'
                ? 'text-fuchsia-300'
                : 'text-amber-300'
            }`}
            aria-hidden="true"
          />
          <div>
            <p className="font-semibold text-white text-[11px]">Active 3D Sky & Lighting Shader</p>
            <p data-testid="donki-3d-effect" className="text-[11px] text-slate-300 leading-snug mt-0.5">
              {skyShaderEffect}
            </p>
          </div>
        </div>

        <div className="flex items-start gap-2 pt-1.5 border-t border-slate-800/80">
          <Zap className="w-3.5 h-3.5 shrink-0 mt-0.5 text-amber-400" aria-hidden="true" />
          <div>
            <p className="font-semibold text-white text-[11px]">Surface Radiation Delta</p>
            <p className="text-[11px] text-slate-300 leading-snug mt-0.5">{radiationSummary}</p>
          </div>
        </div>

        <div className="flex items-start gap-2 pt-1.5 border-t border-slate-800/80">
          <Shield
            className={`w-3.5 h-3.5 shrink-0 mt-0.5 ${
              shieldActive ? 'text-cyan-300' : 'text-slate-400'
            }`}
            aria-hidden="true"
          />
          <div>
            <p className="font-semibold text-white text-[11px]">Water-Wall Shield State</p>
            <p
              data-testid="donki-shield-state"
              className={`text-[11px] leading-snug mt-0.5 ${
                shieldActive ? 'text-cyan-200' : 'text-slate-300'
              }`}
            >
              {shieldSummary}
            </p>
          </div>
        </div>
      </div>

      {/* Judge / Demo Toggle: Simulate Historical X-Flare */}
      <button
        type="button"
        role="switch"
        aria-checked={isSimulatedXFlare}
        data-testid="simulate-x-flare-toggle"
        onClick={() => {
          missionAudio.playClick();
          onToggleSimulateXFlare();
        }}
        className={`w-full flex items-center justify-between gap-3 px-3 py-2.5 rounded-xl border text-left transition-colors cursor-pointer ${
          isSimulatedXFlare
            ? 'bg-rose-950/80 border-rose-500 text-rose-100'
            : 'bg-[#0B1220] hover:bg-slate-800/90 border-slate-700 hover:border-rose-400/70 text-slate-200'
        }`}
      >
        <div className="flex items-center gap-2.5 min-w-0">
          <Flame
            className={`w-4 h-4 shrink-0 ${
              isSimulatedXFlare ? 'text-rose-400' : 'text-amber-400'
            }`}
            aria-hidden="true"
          />
          <div className="min-w-0">
            <p className="text-xs font-semibold text-white leading-tight">
              Simulate Historical X-Flare
            </p>
            <p className="text-[10px] font-mono text-slate-400 leading-tight mt-0.5">
              {isSimulatedXFlare
                ? 'Active: 2017-09-06 X9.3 + 1,571 km/s Halo CME'
                : 'Preview X9.3 CME storm & crimson 3D alert'}
            </p>
          </div>
        </div>

        <span
          aria-hidden="true"
          className={`relative inline-flex h-5 w-9 shrink-0 rounded-full border transition-colors ${
            isSimulatedXFlare
              ? 'bg-rose-500 border-rose-300'
              : 'bg-slate-800 border-slate-600'
          }`}
        >
          <span
            className={`inline-block h-4 w-4 rounded-full bg-white shadow transform transition-transform mt-[1px] ${
              isSimulatedXFlare ? 'translate-x-4' : 'translate-x-0.5'
            }`}
          />
        </span>
      </button>

      {/* Footer Note + Full Archive Button */}
      <div className="flex items-center justify-between gap-2 pt-1 text-[11px]">
        <span className="inline-flex items-center gap-1 font-mono text-slate-400 truncate">
          <Radio className="w-3 h-3 text-cyan-400 shrink-0" aria-hidden="true" />
          <span className="truncate">{flare.source === 'DONKI_LIVE' ? 'NASA Live' : 'CCMC Archive'}</span>
        </span>
        <button
          type="button"
          data-testid="open-science-archive-btn"
          onClick={() => {
            missionAudio.playClick();
            onOpenArchive();
          }}
          className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-slate-800 hover:bg-slate-700 border border-slate-700 text-cyan-300 font-medium cursor-pointer whitespace-nowrap"
        >
          <Database className="w-3 h-3" aria-hidden="true" />
          <span>Science Archive ({unlockedCount}/9)</span>
        </button>
      </div>
    </aside>
  );
};

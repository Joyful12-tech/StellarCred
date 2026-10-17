// frontend/app/holder/HolderPageClient.tsx
'use client';

import React from 'react';
import { useHolderFeatures } from '@/lib/hooks/useHolderFeatures';
import { PreflightSimulationCard } from '@/components/holder/PreflightSimulationCard';
// Import other decomposed holder components...

export default function HolderPageClient() {
  const {
    expiryRemindersEnabled,
    toggleExpiryReminders,
    isSimulatingPreflight,
    runPreflightSimulation,
    proofCacheStatus,
  } = useHolderFeatures();

  return (
    <div className="max-w-4xl mx-auto p-6">
      <header className="mb-6 flex justify-between items-center">
        <h1 className="text-2xl font-bold text-gray-900">Credential Holder Dashboard</h1>
        <button
          type="button"
          onClick={toggleExpiryReminders}
          className="text-sm text-indigo-600 hover:text-indigo-800 font-medium"
        >
          Expiry Reminders: {expiryRemindersEnabled ? 'Enabled' : 'Disabled'}
        </button>
      </header>

      {/* Orchestrated feature blocks */}
      <PreflightSimulationCard
        isSimulating={isSimulatingPreflight}
        onRunSimulation={runPreflightSimulation}
      />

      <div className="text-xs text-gray-500 mt-4">
        Proof Cache Status: <span className="font-semibold">{proofCacheStatus}</span>
      </div>
    </div>
  );
}
import React from 'react';

export function PreflightSimulationCard({
  isSimulating,
  onRunSimulation,
}: {
  isSimulating: boolean;
  onRunSimulation: () => void;
}) {
  return (
    <div className="p-4 bg-white rounded-lg shadow border border-gray-100 mb-4">
      <h3 className="text-md font-semibold text-gray-800 mb-2">Preflight Simulation</h3>
      <p className="text-sm text-gray-600 mb-3">Verify credential transactions before broadcast.</p>
      <button
        type="button"
        onClick={onRunSimulation}
        disabled={isSimulating}
        className="px-4 py-2 bg-blue-600 text-white rounded-md text-sm font-medium hover:bg-blue-700 disabled:opacity-50"
      >
        {isSimulating ? 'Simulating...' : 'Run Preflight Check'}
      </button>
    </div>
  );
}
import React from 'react';

export default function ConsolePage() {
  return (
    <main className="p-8 min-h-screen font-sans" style={{ backgroundColor: '#0B0D14', color: '#EDEAE3' }}>
      <h1 className="text-3xl font-bold mb-8">Lakshman Rekha Console</h1>
      
      <div className="mb-8 p-6 rounded-lg shadow border" style={{ backgroundColor: '#161A26', borderColor: '#333' }}>
        <h2 className="text-xl font-semibold mb-4" style={{ color: '#3DD68C' }}>Wallet Balance</h2>
        <p className="text-4xl font-mono">₹50,000.00</p>
      </div>

      <div className="p-6 rounded-lg shadow border" style={{ backgroundColor: '#161A26', borderColor: '#333' }}>
        <h2 className="text-xl font-semibold mb-4">Live Transaction Feed</h2>
        <div className="flex flex-col gap-4">
          <p className="italic opacity-50">No payments yet. Give your agent a task in the Playground.</p>
        </div>
      </div>
    </main>
  );
}

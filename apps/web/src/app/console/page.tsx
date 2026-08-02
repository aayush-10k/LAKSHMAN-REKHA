'use client';
import React, { useEffect, useState } from 'react';
import { useAccount, useConnect, useDisconnect, useWriteContract } from 'wagmi';
import { injected } from 'wagmi/connectors';

const POLICY_MODULE_ADDRESS = '0x933bb10252ec2b133f28b7d5edf1d303c3384d87';
const revokeAbi = [{ type: 'function', name: 'revoke', stateMutability: 'nonpayable', inputs: [], outputs: [] }] as const;

export default function ConsolePage() {
  const { address, isConnected } = useAccount();
  const { connect } = useConnect();
  const { disconnect } = useDisconnect();
  const { writeContract, isPending, error, isSuccess, data: txHash } = useWriteContract();
  const [events, setEvents] = useState<any[]>([]);

  useEffect(() => {
    // Setting up the SSE for RekhaEvent stream
    const eventSource = new EventSource('http://localhost:4000/v1/events');
    eventSource.onmessage = (e) => {
      try {
        const ev = JSON.parse(e.data);
        setEvents((prev) => [ev, ...prev].slice(0, 50));
      } catch (err) {
        console.error('SSE Parse error', err);
      }
    };
    return () => eventSource.close();
  }, []);

  const handleRevoke = () => {
    writeContract({
      address: POLICY_MODULE_ADDRESS,
      abi: revokeAbi,
      functionName: 'revoke',
    });
  };

  return (
    <main className="p-8 min-h-screen font-sans" style={{ backgroundColor: '#0B0D14', color: '#EDEAE3' }}>
      <div className="flex justify-between items-center mb-8">
        <h1 className="text-3xl font-bold">Lakshman Rekha Console</h1>
        <div>
          {isConnected ? (
            <div className="flex gap-4 items-center">
              <span className="font-mono text-sm text-gray-400">{address}</span>
              <button onClick={() => disconnect()} className="px-4 py-2 rounded bg-gray-800 text-sm text-white">Disconnect</button>
              <button 
                onClick={handleRevoke} 
                disabled={isPending}
                className="px-4 py-2 rounded bg-red-600 hover:bg-red-700 font-bold text-white disabled:opacity-50"
              >
                {isPending ? 'Revoking...' : 'REVOKE ALL'}
              </button>
            </div>
          ) : (
            <button 
              onClick={() => connect({ connector: injected() })}
              className="px-4 py-2 rounded bg-blue-600 hover:bg-blue-700 font-bold text-white"
            >
              Connect Wallet
            </button>
          )}
        </div>
      </div>
      
      {isSuccess && txHash && (
        <div className="mb-8 p-4 bg-green-900/50 border border-green-500 rounded text-green-200">
          Revocation successful! View on Explorer: <a href={`https://sepolia.basescan.org/tx/${txHash}`} target="_blank" rel="noreferrer" className="underline">{txHash}</a>
        </div>
      )}
      
      {error && (
        <div className="mb-8 p-4 bg-red-900/50 border border-red-500 rounded text-red-200 font-mono text-sm whitespace-pre-wrap">
          {error.message}
        </div>
      )}
      
      <div className="mb-8 p-6 rounded-lg shadow border" style={{ backgroundColor: '#161A26', borderColor: '#333' }}>
        <h2 className="text-xl font-semibold mb-4" style={{ color: '#3DD68C' }}>Wallet Balance</h2>
        <p className="text-4xl font-mono">₹50,000.00</p>
      </div>

      <div className="p-6 rounded-lg shadow border" style={{ backgroundColor: '#161A26', borderColor: '#333' }}>
        <h2 className="text-xl font-semibold mb-4">Live Transaction Feed</h2>
        <div className="flex flex-col gap-4">
          {events.length === 0 ? (
            <p className="italic opacity-50">No payments yet. Give your agent a task in the Playground.</p>
          ) : (
            events.map((ev, idx) => (
              <div key={idx} className="p-4 border border-gray-700 rounded bg-gray-800/50 text-sm">
                <span className="text-xs font-mono text-gray-500 block mb-1">{new Date(ev.atMs).toLocaleTimeString()} - {ev.t}</span>
                {ev.t === 'payment.held' && (
                  <div className="text-yellow-400">
                    Payment Held! (Decision: {ev.decisionId})<br />
                    Amount: ₹{(ev.amountMinor / 100).toFixed(2)}
                  </div>
                )}
                {ev.t === 'payment.settled' && (
                  <div className="text-green-400">
                    Payment Settled! <br />
                    <a href={`https://sepolia.basescan.org/tx/${ev.txHash}`} target="_blank" rel="noreferrer" className="underline text-blue-400">View on Basescan: {ev.txHash}</a>
                  </div>
                )}
                {ev.t === 'decision.made' && ev.trace?.outcome === 'REFUSED' && (
                  <div className="text-red-400">
                    Payment Refused: {ev.trace.summary} <br />
                    <span className="font-mono text-xs mt-1 block opacity-75">{ev.trace.bindingPredicate && `Predicate: ${ev.trace.bindingPredicate}`}</span>
                  </div>
                )}
                {ev.t === 'attack.attempt' && ev.blocked && (
                  <div className="text-red-400 font-mono">
                    Attack Blocked: {ev.revertReason}
                  </div>
                )}
                {ev.t !== 'payment.held' && ev.t !== 'payment.settled' && ev.t !== 'decision.made' && ev.t !== 'attack.attempt' && (
                  <pre className="text-xs text-gray-300 overflow-x-auto whitespace-pre-wrap">{JSON.stringify(ev, null, 2)}</pre>
                )}
              </div>
            ))
          )}
        </div>
      </div>
    </main>
  );
}

import { useState } from 'react'
import './App.css'
import TimeOffForm from './components/TimeOffForm'
import BalanceDisplay from './components/BalanceDisplay'
import RequestList from './components/RequestList'

function App() {
  const [activeTab, setActiveTab] = useState<'submit' | 'balance' | 'requests'>('submit')
  const [employeeId, setEmployeeId] = useState('emp-001')
  const [locationId, setLocationId] = useState('loc-us-hq')

  return (
    <div className="app">
      <header className="app-header">
        <h1>⏰ Time-Off Management System</h1>
        <div className="employee-info">
          <label>
            Employee ID:
            <input
              type="text"
              value={employeeId}
              onChange={(e) => setEmployeeId(e.target.value)}
              placeholder="Enter Employee ID"
            />
          </label>
          <label>
            Location ID:
            <input
              type="text"
              value={locationId}
              onChange={(e) => setLocationId(e.target.value)}
              placeholder="Enter Location ID"
            />
          </label>
        </div>
      </header>

      <nav className="tab-navigation">
        <button
          className={activeTab === 'submit' ? 'active' : ''}
          onClick={() => setActiveTab('submit')}
        >
          📝 Submit Request
        </button>
        <button
          className={activeTab === 'balance' ? 'active' : ''}
          onClick={() => setActiveTab('balance')}
        >
          📊 View Balance
        </button>
        <button
          className={activeTab === 'requests' ? 'active' : ''}
          onClick={() => setActiveTab('requests')}
        >
          📋 My Requests
        </button>
      </nav>

      <main className="main-content">
        {activeTab === 'submit' && (
          <TimeOffForm employeeId={employeeId} locationId={locationId} />
        )}
        {activeTab === 'balance' && (
          <BalanceDisplay employeeId={employeeId} locationId={locationId} />
        )}
        {activeTab === 'requests' && (
          <RequestList employeeId={employeeId} />
        )}
      </main>
    </div>
  )
}

export default App

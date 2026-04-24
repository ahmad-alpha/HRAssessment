import { useState, useEffect } from 'react'
import axios from 'axios'
import type { Balance } from '../types'

interface BalanceDisplayProps {
  employeeId: string
  locationId: string
}

const BalanceDisplay = ({ employeeId, locationId }: BalanceDisplayProps) => {
  const [balance, setBalance] = useState<Balance | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const fetchBalance = async () => {
    setLoading(true)
    setError(null)
    try {
      const response = await axios.get<Balance>(
        `/timeoff/balance/${employeeId}/${locationId}`
      )
      setBalance(response.data)
    } catch (err: any) {
      setError(err.response?.data?.message || err.message)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    if (employeeId && locationId) {
      fetchBalance()
    }
  }, [employeeId, locationId])

  if (loading) return <div className="loading">⏳ Loading balance...</div>
  if (error) return <div className="error-msg">❌ {error}</div>

  return (
    <div className="balance-container">
      <h2>Your Time-Off Balance</h2>
      <button onClick={fetchBalance} className="btn-outline" disabled={loading}>
        🔄 Refresh
      </button>

      {balance && (
        <div className="balance-card">
          <div className="balance-item">
            <span className="label">Available Days:</span>
            <span className="value available">{balance.availableDays}</span>
          </div>
          <div className="balance-item">
            <span className="label">Used Days:</span>
            <span className="value used">{balance.usedDays}</span>
          </div>
          <div className="balance-item">
            <span className="label">Pending Days:</span>
            <span className="value pending">{balance.pendingDays}</span>
          </div>
          <div className="balance-item">
            <span className="label">Total Days:</span>
            <span className="value total">{balance.totalDays}</span>
          </div>
          <div className="balance-meta">
            <p>Last Updated: {new Date(balance.lastHcmSync).toLocaleString()}</p>
          </div>
        </div>
      )}
    </div>
  )
}

export default BalanceDisplay

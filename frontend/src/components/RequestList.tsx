import { useState, useEffect } from 'react'
import axios from 'axios'
import type { TimeOffRequest } from '../types'

interface RequestListProps {
  employeeId: string
}

const RequestList = ({ employeeId }: RequestListProps) => {
  const [requests, setRequests] = useState<TimeOffRequest[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [actionLoading, setActionLoading] = useState<string | null>(null)

  const fetchRequests = async () => {
    setLoading(true)
    setError(null)
    try {
      const response = await axios.get<TimeOffRequest[]>(
        `/timeoff/employee/${employeeId.trim()}`
      )
      setRequests(response.data)
    } catch (err: any) {
      setError(err.response?.data?.message || err.message)
      setRequests([])
    } finally {
      setLoading(false)
    }
  }

  const handleAction = async (
    requestId: string,
    action: 'approve' | 'reject' | 'cancel'
  ) => {
    if (actionLoading) return

    if (action === 'cancel') {
      const confirmed = window.confirm(
        'Are you sure you want to cancel this time-off request? This action cannot be undone.'
      )
      if (!confirmed) return
    }

    setActionLoading(requestId)
    setError(null)

    // 🔥 Optimistic UI update
    const prevRequests = [...requests]
    if (action === 'cancel') {
      setRequests(prev =>
        prev.map(r =>
          r.id === requestId ? { ...r, status: 'CANCELLED' } : r
        )
      )
    }

    try {
      const url =
        action === 'cancel'
          ? `/timeoff/${requestId}/cancel`
          : `/timeoff/${requestId}/${action}`

      if (action === 'cancel') {
        await axios.delete(url, {
          params: { employeeId: employeeId.trim() }
        })
      } else {
        await axios.patch(url, {})
      }

      // ✅ Always sync with backend after success
      await fetchRequests()
    } catch (err: any) {
      // 🔁 Revert optimistic update on failure
      setRequests(prevRequests)

      if (err.response?.status === 400) {
        setError(err.response?.data?.message || 'Invalid request')
      } else if (err.response?.status === 404 || err.response?.status === 409) {
        setError('Request already processed. Syncing latest state...')
        await fetchRequests()
      } else if (err.response?.status >= 500) {
        setError('Server error occurred. Please try again later.')
      } else if (!err.response) {
        setError('Network issue detected. Syncing latest state...')
        await fetchRequests()
      } else {
        setError(err.response?.data?.message || err.message)
      }
    } finally {
      setActionLoading(null)
    }
  }

  useEffect(() => {
    if (employeeId) {
      fetchRequests()
    }
  }, [employeeId])

  useEffect(() => {
    setRequests([])
    setError(null)
  }, [employeeId])

  const getStatusBadge = (status: string) => {
    const statusMap: Record<
      string,
      'badge-pending' | 'badge-approved' | 'badge-rejected' | 'badge-cancelled'
    > = {
      PENDING: 'badge-pending',
      APPROVED: 'badge-approved',
      REJECTED: 'badge-rejected',
      CANCELLED: 'badge-cancelled'
    }
    return statusMap[status] || 'badge-pending'
  }

  return (
    <div className="request-list-container">
      <h2>My Time-Off Requests</h2>
      <button
        onClick={fetchRequests}
        className="btn-outline"
        disabled={loading || !!actionLoading}
      >
        🔄 Refresh
      </button>

      {error && (
        <div className="error-msg" style={{ marginTop: '1rem' }}>
          ❌ {error}
        </div>
      )}
      {loading && <div className="loading">⏳ Loading requests...</div>}

      {!loading && requests.length === 0 ? (
        <p>📭 No requests found</p>
      ) : (
        <div className="request-list">
          {requests.map(req => (
            <div key={req.id} className="request-card">
              <div className="request-header">
                <span className={`badge ${getStatusBadge(req.status)}`}>
                  {req.status}
                </span>
                <span className="request-id">
                  {req.id.substring(0, 8)}...
                </span>
              </div>

              <div>
                <div className="detail-row">
                  <span className="label">Start Date:</span>
                  <span>
                    {new Date(req.startDate).toLocaleDateString()}
                  </span>
                </div>
                <div className="detail-row">
                  <span className="label">End Date:</span>
                  <span>
                    {new Date(req.endDate).toLocaleDateString()}
                  </span>
                </div>
                <div className="detail-row">
                  <span className="label">Days Requested:</span>
                  <span>{req.daysRequested}</span>
                </div>
                {req.reason && (
                  <div className="detail-row">
                    <span className="label">Reason:</span>
                    <span>{req.reason}</span>
                  </div>
                )}
                <div className="detail-row">
                  <span className="label">Submitted:</span>
                  <span>
                    {new Date(req.createdAt).toLocaleString()}
                  </span>
                </div>
              </div>

              {req.status === 'PENDING' && (
                <div className="request-actions">
                  <button
                    onClick={() => handleAction(req.id, 'cancel')}
                    disabled={actionLoading === req.id}
                    className="btn-action btn-cancel"
                  >
                    {actionLoading === req.id ? '⏳' : '❌'} Cancel
                  </button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

export default RequestList

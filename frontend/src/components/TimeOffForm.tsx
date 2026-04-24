import { useState } from 'react'
import axios from 'axios'
import { v4 as uuidv4 } from 'uuid'
import type { CreateTimeOffRequestDto, TimeOffRequest } from '../types'

interface TimeOffFormProps {
  employeeId: string
  locationId: string
}

const TimeOffForm = ({ employeeId, locationId }: TimeOffFormProps) => {
  const [formData, setFormData] = useState({
    startDate: new Date().toISOString().split('T')[0],
    endDate: new Date().toISOString().split('T')[0],
    daysRequested: 1,
    reason: '',
  })
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState<TimeOffRequest | null>(null)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setLoading(true)
    setError(null)
    setSuccess(null)

    try {
      const dto: CreateTimeOffRequestDto = {
        idempotencyKey: uuidv4(),
        employeeId,
        locationId,
        startDate: formData.startDate,
        endDate: formData.endDate,
        daysRequested: formData.daysRequested,
        reason: formData.reason || undefined,
      }

      const response = await axios.post<TimeOffRequest>(
        '/timeoff',
        dto
      )

      setSuccess(response.data)
      setFormData({
        startDate: new Date().toISOString().split('T')[0],
        endDate: new Date().toISOString().split('T')[0],
        daysRequested: 1,
        reason: '',
      })
    } catch (err: any) {
      // Handle different types of errors
      if (err.response?.status === 409) {
        setError('This request has already been submitted. Please check your existing requests.')
      } else if (err.response?.status >= 500) {
        setError('Server error occurred. Please try again later.')
      } else if (!err.response) {
        setError('Network error. Please check your connection and try again.')
      } else {
        setError(err.response?.data?.message || err.message)
      }
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="form-max-width">
      <h2>Submit Time-Off Request</h2>

      {error && <div className="error-msg">❌ {error}</div>}

      
      {success && (
        <div className="success-msg">
          ✅ Request submitted! ID: {success.id.substring(0, 8)}...
        </div>
      )}

      <form onSubmit={handleSubmit}>
        <div className="form-group">
          <label>Start Date</label>
          <input
            type="date"
            value={formData.startDate}
            onChange={(e) =>
              setFormData({ ...formData, startDate: e.target.value })
            }
            required
          />
        </div>

        <div className="form-group">
          <label>End Date</label>
          <input
            type="date"
            value={formData.endDate}
            onChange={(e) =>
              setFormData({ ...formData, endDate: e.target.value })
            }
            required
          />
        </div>

        <div className="form-group">
          <label>Days Requested</label>
          <input
            type="number"
            min="1"
            value={formData.daysRequested}
            onChange={(e) =>
              setFormData({
                ...formData,
                daysRequested: parseInt(e.target.value),
              })
            }
            required
          />
        </div>

        <div className="form-group">
          <label>Reason (Optional)</label>
          <textarea
            value={formData.reason}
            onChange={(e) =>
              setFormData({ ...formData, reason: e.target.value })
            }
            placeholder="Enter your reason for time-off..."
          />
        </div>

        <button type="submit" className="submit-btn" disabled={loading}>
          {loading ? 'Submitting...' : 'Submit Request'}
        </button>
      </form>
    </div>
  )
}

export default TimeOffForm

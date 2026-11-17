import { useId } from 'react'
import { Modal } from '@components/ui/Modal'
import styles from './TunnelLostDialog.module.css'

export interface TunnelLostRequest {
  requestId: string
  profileName: string
}

/** The in-app prompt for a dropped Teleport tunnel; answering resolves the
 * blocked action in the main process. Escape and backdrop clicks cancel. */
export function TunnelLostDialog({
  request,
  onAnswer,
}: {
  request: TunnelLostRequest
  onAnswer: (requestId: string, reconnect: boolean) => void
}) {
  const titleId = useId()
  const descriptionId = useId()
  return (
    <Modal
      open
      onClose={() => onAnswer(request.requestId, false)}
      labelledBy={titleId}
      describedBy={descriptionId}
    >
      <h2 id={titleId}>Teleport tunnel lost</h2>
      <p id={descriptionId}>
        The Teleport tunnel for &quot;{request.profileName}&quot; dropped.
        Reconnect it now?
      </p>
      <div className={styles.actions}>
        <button
          type="button"
          className="btn ghost"
          onClick={() => onAnswer(request.requestId, false)}
        >
          Cancel
        </button>
        <button
          type="button"
          className="btn"
          onClick={() => onAnswer(request.requestId, true)}
        >
          Reconnect
        </button>
      </div>
    </Modal>
  )
}

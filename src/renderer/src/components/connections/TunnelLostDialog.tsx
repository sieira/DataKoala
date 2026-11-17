import { ConfirmationDialog } from '@components/ui/ConfirmationDialog'

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
  return (
    <ConfirmationDialog
      open
      title="Teleport tunnel lost"
      description={`The Teleport tunnel for "${request.profileName}" dropped. Reconnect it now?`}
      confirmLabel="Reconnect"
      confirmClassName="btn"
      onCancel={() => onAnswer(request.requestId, false)}
      onConfirm={() => onAnswer(request.requestId, true)}
    />
  )
}

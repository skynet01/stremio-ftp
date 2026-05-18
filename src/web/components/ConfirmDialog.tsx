import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { AlertTriangle, X } from "lucide-react";

export type ConfirmDialogOptions = {
  title: string;
  body: ReactNode;
  confirmLabel: string;
  cancelLabel?: string;
  danger?: boolean;
};

type PendingConfirmation = ConfirmDialogOptions & {
  id: number;
};

export function useConfirmDialog() {
  const [dialog, setDialog] = useState<PendingConfirmation | null>(null);
  const resolver = useRef<((confirmed: boolean) => void) | null>(null);

  const close = useCallback((confirmed: boolean) => {
    resolver.current?.(confirmed);
    resolver.current = null;
    setDialog(null);
  }, []);

  const confirm = useCallback((options: ConfirmDialogOptions) => {
    resolver.current?.(false);
    return new Promise<boolean>((resolve) => {
      resolver.current = resolve;
      setDialog({ ...options, id: Date.now() });
    });
  }, []);

  const confirmDialog = dialog ? <ConfirmDialog dialog={dialog} onClose={close} /> : null;
  return { confirm, confirmDialog };
}

function ConfirmDialog({ dialog, onClose }: { dialog: PendingConfirmation; onClose: (confirmed: boolean) => void }) {
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") onClose(false);
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  return createPortal(
    <div className="modal-backdrop" onMouseDown={() => onClose(false)}>
      <div
        className={`modal-dialog confirm-dialog ${dialog.danger ? "confirm-dialog-danger" : ""}`}
        role="dialog"
        aria-modal={true}
        aria-labelledby={`confirm-dialog-title-${dialog.id}`}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="modal-dialog-header">
          <div className="confirm-dialog-title-row">
            <span className="confirm-dialog-icon" aria-hidden="true">
              <AlertTriangle size={18} />
            </span>
            <div>
              <span className="section-label">Confirm</span>
              <h3 id={`confirm-dialog-title-${dialog.id}`}>{dialog.title}</h3>
            </div>
          </div>
          <button type="button" className="icon-button" aria-label="Close confirmation" onClick={() => onClose(false)}>
            <X size={16} aria-hidden="true" />
          </button>
        </div>
        <div className="confirm-dialog-body">{dialog.body}</div>
        <div className="confirm-dialog-actions">
          <button type="button" className="secondary-button" onClick={() => onClose(false)}>
            {dialog.cancelLabel ?? "Cancel"}
          </button>
          <button type="button" className={`secondary-button ${dialog.danger ? "danger-button" : ""}`} onClick={() => onClose(true)}>
            {dialog.confirmLabel}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

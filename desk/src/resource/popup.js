const openPopups = [];

// Popups share placement and dismissal; callers retain their existing dialog results and forms.
export function showPopup(panel, anchor = document.activeElement, { placement = 'auto', point } = {}) {
  if (panel.matches(':popover-open')) {
    if (panel instanceof HTMLDialogElement && !panel.open) {
      panel.returnValue = '';
      panel.show();
    }
    return;
  }
  const parent = anchor?.closest?.(':popover-open');
  if (parent && !parent.contains(panel)) {
    parent.append(panel);
  }
  panel.classList.add('desk-popup');
  panel.popover = 'manual';
  const dialog = panel instanceof HTMLDialogElement;
  if (dialog) {
    panel.returnValue = '';
    panel.show();
  }
  panel.showPopover();
  openPopups.push(panel);
  const controller = new AbortController();
  const options = { signal: controller.signal };
  const place = () => positionPopup(panel, anchor, { placement, point });
  place();
  const observer = new ResizeObserver(place);
  observer.observe(panel);
  window.addEventListener('resize', place, options);
  const topmost = () => openPopups.filter(node => node.matches(':popover-open')).at(-1) === panel;
  const dismiss = () => {
    const event = new Event('cancel', { cancelable: true });
    if (panel.dispatchEvent(event)) {
      dialog ? panel.close() : panel.hidePopover();
    }
  };
  const releaseMenu = panel.matches('[role=menu]') || panel.querySelector('[role=menu]')
    ? dismissMenuOnLeave(panel, dismiss) : () => {};
  document.addEventListener('pointerdown', event => {
    if (topmost() && !panel.contains(event.target)) {
      dismiss();
    }
  }, options);
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && topmost()) {
      event.preventDefault();
      event.stopImmediatePropagation();
      dismiss();
    }
  }, { ...options, capture: true });
  panel.addEventListener('close', () => {
    // A caller can close and reopen a retained dialog before the queued close event arrives.
    if (!panel.open && panel.matches(':popover-open')) {
      panel.querySelectorAll('.desk-popup:popover-open').forEach(closePopup);
      panel.hidePopover();
    }
  }, options);
  panel.addEventListener('toggle', event => {
    if (event.newState === 'closed') {
      releaseMenu();
      controller.abort();
      observer?.disconnect();
      openPopups.splice(openPopups.indexOf(panel), 1);
      if (anchor?.isConnected) {
        anchor.focus();
      }
    }
  }, options);
}

export function closePopup(panel) {
  panel.querySelectorAll('.desk-popup:popover-open').forEach(closePopup);
  if (panel instanceof HTMLDialogElement && panel.open) {
    panel.close();
  }
  if (panel.matches(':popover-open')) {
    panel.hidePopover();
  }
}

// A short grace period lets the pointer cross the gap into a nested menu without dismissing its parent.
export function dismissMenuOnLeave(menu, dismiss) {
  let timer;
  const cancel = () => clearTimeout(timer);
  const leave = () => {
    cancel();
    timer = setTimeout(() => {
      if (!menu.matches(':hover') && ![...menu.querySelectorAll(':popover-open')].some(node => node.matches(':hover'))) {
        dismiss();
      }
    }, 250);
  };
  menu.addEventListener('pointerenter', cancel);
  menu.addEventListener('pointerleave', leave);
  return () => {
    cancel();
    menu.removeEventListener('pointerenter', cancel);
    menu.removeEventListener('pointerleave', leave);
  };
}

// All workspace and plugin menus share edge avoidance, including wide menus in narrow views.
export function positionPopup(panel, anchor, { placement = 'auto', point } = {}) {
  const bounds = point ? { left: point.x, right: point.x, top: point.y } : anchor?.getBoundingClientRect();
  const width = panel.offsetWidth;
  const height = panel.offsetHeight;
  const menu = panel.matches('[role=menu]') || panel.querySelector('[role=menu]');
  if (placement === 'center' || (placement === 'auto' && !menu && width >= Math.min(560, innerWidth * 0.75))) {
    panel.style.left = `${Math.max(8, (innerWidth - width) / 2)}px`;
    panel.style.top = `${Math.max(8, (innerHeight - height) / 2)}px`;
    return;
  }
  const right = (bounds?.right ?? 8) + 8;
  const left = right + width <= innerWidth - 8 ? right : (bounds?.left ?? 8) - width - 8;
  panel.style.left = `${Math.max(8, Math.min(left, innerWidth - width - 8))}px`;
  panel.style.top = `${Math.max(8, Math.min(bounds?.top ?? 8, innerHeight - height - 8))}px`;
}

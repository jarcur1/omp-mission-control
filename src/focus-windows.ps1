param(
  [Parameter(Mandatory = $true)]
  [ValidatePattern('^\[MC:[a-f0-9-]{36}\]$')]
  [string]$Marker
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class MissionControlWindow {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr window);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr window, int command);
}
'@
$root = [System.Windows.Automation.AutomationElement]::RootElement
$windows = $root.FindAll([System.Windows.Automation.TreeScope]::Children,
  [System.Windows.Automation.PropertyCondition]::new(
    [System.Windows.Automation.AutomationElement]::ClassNameProperty, 'CASCADIA_HOSTING_WINDOW_CLASS'))
$matches = @()
foreach ($window in $windows) {
  # Tab headers exist even when the tab is inactive; pane text controls identify splits.
  $tabs = $window.FindAll([System.Windows.Automation.TreeScope]::Descendants,
    [System.Windows.Automation.PropertyCondition]::new(
      [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
      [System.Windows.Automation.ControlType]::TabItem))
  foreach ($tab in $tabs) {
    if ($tab.Current.Name.Contains($Marker)) {
      $matches += [pscustomobject]@{ Window = $window; Tab = $tab }
    }
  }
  if (-not ($matches | Where-Object { $_.Window.Equals($window) })) {
    $controls = $window.FindAll([System.Windows.Automation.TreeScope]::Descendants,
      [System.Windows.Automation.PropertyCondition]::new(
        [System.Windows.Automation.AutomationElement]::ClassNameProperty, 'TermControl'))
    foreach ($control in $controls) {
      if ($control.Current.HelpText.Contains($Marker)) {
        $matches += [pscustomobject]@{ Window = $window; Tab = $null }
        break
      }
    }
  }
}
if ($matches.Count -ne 1) {
  throw "Expected exactly one Windows Terminal tab for $Marker; found $($matches.Count). Enable application-controlled tab titles and do not rename the tab."
}
$target = $matches[0]
$handle = [IntPtr]$target.Window.Current.NativeWindowHandle
[void][MissionControlWindow]::ShowWindowAsync($handle, 9)
if ($null -ne $target.Tab) {
  $pattern = $target.Tab.GetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern)
  $pattern.Select()
  if (-not $pattern.Current.IsSelected) { throw 'Windows Terminal did not select the requested tab.' }
}
# Terminal exposes the application title as HelpText; Name is the profile name.
# Re-read after tab selection, which can realize the content asynchronously.
$focused = $false
for ($attempt = 0; $attempt -lt 10 -and -not $focused; $attempt++) {
  $panes = $target.Window.FindAll([System.Windows.Automation.TreeScope]::Descendants,
    [System.Windows.Automation.PropertyCondition]::new(
      [System.Windows.Automation.AutomationElement]::ClassNameProperty, 'TermControl'))
  foreach ($pane in $panes) {
    if ($pane.Current.HelpText.Contains($Marker) -and $pane.Current.IsKeyboardFocusable) {
      $pane.SetFocus()
      $focused = $pane.Current.HasKeyboardFocus
      break
    }
  }
  if (-not $focused) { Start-Sleep -Milliseconds 100 }
}
if (-not $focused) { throw 'Tab selected, but terminal input focus was not confirmed. Click the target pane to focus it.' }
if ([MissionControlWindow]::GetForegroundWindow() -ne $handle) {
  [void][MissionControlWindow]::SetForegroundWindow($handle)
}
if ([MissionControlWindow]::GetForegroundWindow() -ne $handle) {
  throw 'Windows refused foreground activation. The target tab was selected; activate its window manually.'
}

;
; Terms of Service and Privacy Policy page for the assisted installer.
;
; Uses the customWelcomePage hook, which the installer template inserts ahead of
; every other page, so this is the FIRST thing shown: it comes before the install
; mode and install location pages, and long before anything is written to disk.
; The install step cannot be reached without ticking the box.
;
; The text is not embedded here. It is read at install time from
; terms-and-privacy.txt next to this file, in chunks, because a single NSIS string is
; capped at 1024 characters. Edit that text file to change the terms; this script only
; has to change if the page's layout or behaviour does.
;
; Two NSIS details this page depends on, both easy to reintroduce as bugs:
;
;  1. Messages that take a POINTER to text - EM_REPLACESEL, WM_SETTEXT - need the
;     "STR:" prefix on the parameter. Without it NSIS passes the string itself as the
;     pointer, the control dereferences it, and the installer dies with
;     0xC000041D (fatal exception in a window callback) the moment the page is shown.
;  2. FileRead returns whole lines including their line endings, and a single read is
;     capped by the NSIS string limit, so the loop appends until it reads empty.
;
; Verified on this build, with real mouse input: this page is the first one shown,
; Next is disabled on arrival, a click on it while unticked does not advance, ticking
; the box enables it, and clicking it then advances to the install mode page. The page
; is installer-only; see the !ifndef guard below.
;

; Installer only: the uninstaller has no page flow, and page functions defined there
; would be unreferenced, which NSIS warns about (and the build treats warnings as
; errors).
!ifndef BUILD_UNINSTALLER

; This file is included ahead of installer.nsi, so MUI2 is pulled in here: the page
; body below uses MUI_HEADER_TEXT, and !insertmacro inside a function body is expanded
; when the file is parsed. MUI2 guards itself, so installer.nsi including it again
; later is a no-op.
!include "MUI2.nsh"
!include "nsDialogs.nsh"
!include "LogicLib.nsh"

Var TermsDialog
Var TermsBody
Var TermsCheckbox
Var TermsNextButton
Var TermsFile
Var TermsChunk
Var TermsScratch

!macro customWelcomePage
  Page custom termsPageShow termsPageLeave
!macroend

Function termsPageShow
  ; Rebuilt every time the page is shown, so coming back with Back asks for
  ; acceptance again rather than remembering a stale tick.
  StrCpy $TermsFile ""

  nsDialogs::Create 1018
  Pop $TermsDialog
  ${If} $TermsDialog == error
    Abort
  ${EndIf}

  !insertmacro MUI_HEADER_TEXT "Terms of Service and Privacy Policy" "Read and accept the terms to continue."

  ${NSD_CreateLabel} 0 0 100% 16u "Please read the Terms of Service and Privacy Policy below.$\r$\nYou must accept them before HotSound can be installed."
  Pop $TermsScratch

  ; A rich edit box scrolls the whole document, which a single-line text field cannot.
  ${NSD_CreateRichEdit} 0 18u 100% -40u ""
  Pop $TermsBody
  ; Created writable so it can be filled, locked afterwards.
  SendMessage $TermsBody ${EM_SETREADONLY} 0 0

  SetOutPath $PLUGINSDIR
  File "/oname=terms.txt" "${__FILEDIR__}\terms-and-privacy.txt"

  FileOpen $TermsFile "$PLUGINSDIR\terms.txt" r
  ${If} $TermsFile == ""
    SendMessage $TermsBody ${EM_REPLACESEL} 0 "STR:The terms could not be read from this installer."
  ${Else}
    ${Do}
      FileRead $TermsFile $TermsChunk 900
      ${If} $TermsChunk == ""
        ${ExitDo}
      ${EndIf}
      SendMessage $TermsBody ${EM_REPLACESEL} 0 "STR:$TermsChunk"
    ${Loop}
    FileClose $TermsFile
  ${EndIf}

  SendMessage $TermsBody ${EM_SETREADONLY} 1 0
  ; Show the top of the document, not the end the caret was left at.
  SendMessage $TermsBody ${EM_SETSEL} 0 0
  SendMessage $TermsBody ${EM_SCROLLCARET} 0 0

  ${NSD_CreateCheckbox} 0 -22u 100% 12u "I have read and accept the Terms of Service and Privacy Policy"
  Pop $TermsCheckbox
  ${NSD_OnClick} $TermsCheckbox termsPageToggled

  ; Next is the wizard's control 1. It stays disabled until the box is ticked.
  GetDlgItem $TermsNextButton $HWNDPARENT 1
  EnableWindow $TermsNextButton 0

  nsDialogs::Show
FunctionEnd

Function termsPageToggled
  ${NSD_GetState} $TermsCheckbox $TermsScratch
  ${If} $TermsScratch == ${BST_CHECKED}
    EnableWindow $TermsNextButton 1
  ${Else}
    EnableWindow $TermsNextButton 0
  ${EndIf}
FunctionEnd

Function termsPageLeave
  ; Second line of defence: leaving without acceptance is refused here too, in case
  ; anything ever re-enables the button.
  ${NSD_GetState} $TermsCheckbox $TermsScratch
  ${If} $TermsScratch != ${BST_CHECKED}
    MessageBox MB_ICONEXCLAMATION|MB_OK "You must accept the Terms of Service and Privacy Policy before HotSound can be installed."
    Abort
  ${EndIf}
FunctionEnd

!endif

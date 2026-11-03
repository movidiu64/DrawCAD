; Installer DrawCAD pentru Windows (Inno Setup 6). Instalare per utilizator, fără drepturi de
; administrator, în %LOCALAPPDATA%\Programs\DrawCAD.
; Compilare: ISCC /DAppVersion=1.2.3 /DSrcDir=dist\DrawCAD desktop\drawcad.iss

#ifndef AppVersion
  #define AppVersion "0.0.0"
#endif
#ifndef SrcDir
  #define SrcDir "..\dist\DrawCAD"
#endif

[Setup]
AppId={{6B3C2B4E-8E7A-4C51-9A3F-2D5E1B7C9A40}
AppName=DrawCAD
AppVersion={#AppVersion}
AppVerName=DrawCAD {#AppVersion}
AppPublisher=Ovidiu
DefaultDirName={localappdata}\Programs\DrawCAD
DefaultGroupName=DrawCAD
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
PrivilegesRequiredOverridesAllowed=dialog
OutputDir=..\dist
OutputBaseFilename=DrawCAD-{#AppVersion}-setup
SetupIconFile=drawcad.ico
UninstallDisplayIcon={app}\DrawCAD.exe
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
ChangesAssociations=yes
CloseApplications=yes

[Languages]
; Inno Setup nu are traducere oficială în română: textele generale rămân în engleză
Name: "en"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"
Name: "openwith"; Description: "„Deschide cu DrawCAD” pentru PDF-uri și imagini (nu devine aplicația implicită)"; GroupDescription: "Integrare:"

[Files]
Source: "{#SrcDir}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "..\LICENSE"; DestDir: "{app}"; DestName: "LICENSE.txt"; Flags: ignoreversion

[Icons]
Name: "{group}\DrawCAD"; Filename: "{app}\DrawCAD.exe"
Name: "{group}\{cm:UninstallProgram,DrawCAD}"; Filename: "{uninstallexe}"
Name: "{userdesktop}\DrawCAD"; Filename: "{app}\DrawCAD.exe"; Tasks: desktopicon

[Registry]
Root: HKCU; Subkey: "Software\Classes\DrawCAD.Document"; ValueType: string; ValueData: "Desen DrawCAD"; Flags: uninsdeletekey; Tasks: openwith
Root: HKCU; Subkey: "Software\Classes\DrawCAD.Document\DefaultIcon"; ValueType: string; ValueData: "{app}\DrawCAD.exe,0"; Tasks: openwith
Root: HKCU; Subkey: "Software\Classes\DrawCAD.Document\shell\open\command"; ValueType: string; ValueData: """{app}\DrawCAD.exe"" ""%1"""; Tasks: openwith
Root: HKCU; Subkey: "Software\Classes\.pdf\OpenWithProgids"; ValueType: string; ValueName: "DrawCAD.Document"; ValueData: ""; Flags: uninsdeletevalue; Tasks: openwith
Root: HKCU; Subkey: "Software\Classes\.png\OpenWithProgids"; ValueType: string; ValueName: "DrawCAD.Document"; ValueData: ""; Flags: uninsdeletevalue; Tasks: openwith
Root: HKCU; Subkey: "Software\Classes\.tif\OpenWithProgids"; ValueType: string; ValueName: "DrawCAD.Document"; ValueData: ""; Flags: uninsdeletevalue; Tasks: openwith
Root: HKCU; Subkey: "Software\Classes\.tiff\OpenWithProgids"; ValueType: string; ValueName: "DrawCAD.Document"; ValueData: ""; Flags: uninsdeletevalue; Tasks: openwith
Root: HKCU; Subkey: "Software\Classes\.jpg\OpenWithProgids"; ValueType: string; ValueName: "DrawCAD.Document"; ValueData: ""; Flags: uninsdeletevalue; Tasks: openwith

[Run]
Filename: "{app}\DrawCAD.exe"; Description: "{cm:LaunchProgram,DrawCAD}"; Flags: nowait postinstall skipifsilent

[Code]
// WebView2 (motorul ferestrei) vine cu Windows 11 și cu Edge pe Windows 10. Dacă lipsește,
// aplicația se deschide în browser; aici doar avertizăm.
function WebView2Present(): Boolean;
var v: String;
begin
  Result :=
    RegQueryStringValue(HKLM, 'SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}', 'pv', v) or
    RegQueryStringValue(HKLM, 'SOFTWARE\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}', 'pv', v) or
    RegQueryStringValue(HKCU, 'Software\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}', 'pv', v);
  if Result then Result := (v <> '') and (v <> '0.0.0.0');
end;

procedure CurStepChanged(CurStep: TSetupStep);
begin
  if (CurStep = ssPostInstall) and (not WebView2Present()) and (not WizardSilent()) then
    MsgBox('Pe acest calculator lipsește Microsoft Edge WebView2 Runtime. DrawCAD va porni în browser.' + #13#10 +
           'Pentru fereastra proprie, instalează WebView2 de la https://developer.microsoft.com/microsoft-edge/webview2/',
           mbInformation, MB_OK);
end;

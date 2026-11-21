; StudyGraph 桌面版安装包（Inno Setup 6）
;
; 用法：
;   ISCC.exe scripts\desktop-installer.iss /DSourceDir="dist-desktop\20261120141858\StudyGraph" /DAppVersion="0.1.0"
;
; 两个必须遵守的约束（都是实测踩出来的，改之前先看 docs/桌面-内置数据库构建.md）：
;   · 安装路径必须是纯 ASCII：Electron 二进制在含中文的目录下启动即崩，PostgreSQL 二进制同理
;   · 数据在 {localappdata}\StudyGraph，卸载时问用户要不要一并删掉

#ifndef SourceDir
  #error 必须用 /DSourceDir= 指定打包产物目录
#endif
#ifndef AppVersion
  #define AppVersion "0.1.0"
#endif

#define AppName "StudyGraph"
#define AppExe "StudyGraph.exe"

[Setup]
; AppId 固定不变：改了会导致升级安装变成并存安装
AppId={{8E3D7A21-5C46-4F0B-9B7E-2A6C1F5D4B93}
AppName={#AppName}
AppVersion={#AppVersion}
AppVerName={#AppName} {#AppVersion}
DefaultDirName={autopf}\{#AppName}
DefaultGroupName={#AppName}
DisableProgramGroupPage=yes
OutputDir=..\dist-desktop\installer
OutputBaseFilename=StudyGraph-Setup-{#AppVersion}
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
UninstallDisplayIcon={app}\{#AppExe}
UninstallDisplayName={#AppName}
; 按用户安装：不要求管理员权限，学生机器上通常也没有管理员
PrivilegesRequired=lowest

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "Create a desktop shortcut"; GroupDescription: "Additional shortcuts:"

[Files]
Source: "{#SourceDir}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{group}\{#AppName}"; Filename: "{app}\{#AppExe}"
Name: "{group}\Uninstall {#AppName}"; Filename: "{uninstallexe}"
Name: "{autodesktop}\{#AppName}"; Filename: "{app}\{#AppExe}"; Tasks: desktopicon

[Run]
Filename: "{app}\{#AppExe}"; Description: "Launch {#AppName}"; Flags: nowait postinstall skipifsilent

[Code]
const
  DataDirName = 'StudyGraph';

function IsAsciiPath(const S: String): Boolean;
var
  I: Integer;
begin
  Result := True;
  for I := 1 to Length(S) do
    if Ord(S[I]) > 127 then
    begin
      Result := False;
      Exit;
    end;
end;

{ 安装目录必须纯 ASCII —— 否则 Electron 起不来，学生只会看到"双击没反应" }
function NextButtonClick(CurPageID: Integer): Boolean;
begin
  Result := True;
  if CurPageID = wpSelectDir then
  begin
    if not IsAsciiPath(WizardDirValue) then
    begin
      MsgBox('The installation path must contain only English letters, digits and symbols.' + #13#10 +
             'PostgreSQL and Electron cannot run from a path with Chinese characters.' + #13#10#13#10 +
             'Please choose a path such as C:\Program Files\StudyGraph.', mbError, MB_OK);
      Result := False;
    end;
  end;
end;

{ 卸载时询问是否删除数据（数据库、课件、本机 token 都在这里） }
procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
var
  DataDir: String;
begin
  if CurUninstallStep = usPostUninstall then
  begin
    DataDir := ExpandConstant('{localappdata}\' + DataDirName);
    if DirExists(DataDir) then
    begin
      if MsgBox('Also delete your StudyGraph data?' + #13#10#13#10 +
                DataDir + #13#10#13#10 +
                'This removes all canvases, course materials and the local database. ' +
                'Choose No to keep them for a future reinstall.', mbConfirmation, MB_YESNO) = IDYES then
        DelTree(DataDir, True, True, True);
    end;
  end;
end;

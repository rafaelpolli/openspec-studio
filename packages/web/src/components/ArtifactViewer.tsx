import type { ArtifactFile } from "@studio/shared";
import Markdown from "react-markdown";

export function ArtifactViewer({ files }: { files: ArtifactFile[] }) {
  if (files.length === 0) return <p className="empty">Este artefato ainda não foi escrito.</p>;
  return (
    <div className="artifact">
      {files.map((file) => (
        <section key={file.path}>
          {files.length > 1 && <h4 className="file-path">{file.path}</h4>}
          <div className="markdown">
            <Markdown>{file.content}</Markdown>
          </div>
        </section>
      ))}
    </div>
  );
}

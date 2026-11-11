import React, { useState } from 'react';

export function ProjectIcon({ project, fallback:Fallback, size }) {
  const [failed, setFailed] = useState(null);
  return project.icon && failed !== project.icon
    ? <img src={project.icon} alt="" draggable={false} onError={() => setFailed(project.icon)}/>
    : <Fallback size={size}/>;
}

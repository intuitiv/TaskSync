# Distributed TaskSync – Vocabulary

> A shared language for discussing the distributed multi-agent orchestration system.

---

## Core Entities

### **Node**
A unit of execution in the orchestration graph. A Node can be:
- **Agent Node**: An autonomous LLM-backed session (e.g., Copilot).
- **Human Node**: A manual intervention point where a user takes control.
- **Gateway Node**: A routing/decision point that directs flow based on conditions.

### **Edge**
A directed connection between two Nodes representing:
- **Data Flow**: Artifacts passed from source to target.
- **Control Flow**: Execution order and dependencies.
- **Feedback Loop**: Return path for validation or rejection.

### **Graph / Pipeline**
The complete DAG (Directed Acyclic Graph) of Nodes and Edges defining a workflow.

### **Orchestrator**
The central service that:
- Manages the Graph state.
- Routes messages between Nodes.
- Tracks execution progress.
- Handles human intervention requests.

---

## Agent Concepts

### **Persona**
A system prompt template that defines an agent's role, tone, and constraints.
Examples: `ProductManagerPersona`, `ArchitectPersona`, `EngineerPersona`, `QAPersona`.

### **Session**
A single Copilot conversation instance. Sessions can be:
- **Local**: Running in the same VS Code window.
- **Workspace-Remote**: Running in a different VS Code window on the same machine.
- **Machine-Remote**: Running on a different machine, connected via network.

### **Capability**
A declared skill or tool an agent can use (e.g., `code-generation`, `file-read`, `web-search`).

---

## Artifact Concepts

### **Artifact**
Any output produced by a Node. Examples:
- Requirements Document
- Architecture Diagram
- Code File
- Test Report

### **Artifact Registry**
A versioned store of all artifacts, enabling:
- Traceability (which Node produced what).
- Rollback (revert to previous versions).
- Comparison (diff between iterations).

### **Handoff Payload**
The structured data passed between Nodes, containing:
- `artifact_id`: Reference to the artifact.
- `context`: Relevant conversation history.
- `instructions`: What the next Node should do.

---

## Execution Concepts

### **Task**
A discrete unit of work assigned to a Node. A Task has:
- `id`: Unique identifier.
- `input`: The Handoff Payload received.
- `output`: The resulting Artifact(s).
- `status`: `pending` | `in-progress` | `completed` | `failed` | `paused`.

### **Run**
A single execution of the entire Graph from start to finish.

### **Checkpoint**
A saved state of a Run, allowing:
- Pause/Resume.
- Human review before continuing.
- Branching (explore alternative paths).

---

## Intervention Concepts

### **Takeover**
When a human replaces an Agent Node and manually performs the task.

### **Inspection**
Viewing the current state, artifacts, and conversation of a Node without taking control.

### **Feedback Injection**
Providing guidance to an Agent Node without taking over (e.g., "reconsider the database choice").

### **Approval Gate**
A special Gateway Node that halts execution until a human approves.

---

## Communication Protocols

### **Synapse**
The TaskSync coupling mechanism that:
- Receives output from one Node.
- Validates/transforms the output.
- Forwards to the next Node(s).

### **Heartbeat**
Periodic status signal from remote Nodes to the Orchestrator, indicating:
- `alive`: Node is responsive.
- `busy`: Node is processing a Task.
- `idle`: Node is waiting for work.

### **MCP (Model Context Protocol)**
The standard protocol for exposing tools to LLMs. Extended for inter-agent communication.

---

## UI Concepts

### **Canvas**
The main graph visualization area showing Nodes and Edges.

### **Inspector Panel**
A sidebar showing details of the selected Node:
- Conversation history.
- Current Task status.
- Produced Artifacts.

### **Artifact Viewer**
A drill-down view showing the content of a specific Artifact with diff capabilities.

### **Control Bar**
Top-level controls: `Run`, `Pause`, `Step`, `Reset`, `Takeover`.

---

## Example Personas

| Persona | Role | Key Behaviors |
|---------|------|---------------|
| `PM` | Product Manager | Clarifies requirements, writes user stories, prioritizes features |
| `ARCH` | Architect | Designs system structure, defines interfaces, evaluates feasibility |
| `ENG` | Engineer | Writes code, implements features, fixes bugs |
| `QA` | Quality Assurance | Reviews code, writes tests, validates requirements |
| `DOCS` | Documentation | Writes READMEs, API docs, user guides |

---

*Use this vocabulary consistently across all design documents and discussions.*

"use client"
import {
  IconArrowLeft,
  IconBrandTabler,
  IconSettings,
  IconUserBolt,
  IconPackage,
  IconTemplate,
  IconCode,
  IconTrash,
  IconFolderDown,
  IconLoader,
  IconFileDownload,
  IconUpload,
  IconPlayerPlayFilled,
  IconBrandGithub,
  IconDeviceFloppy,
} from "@tabler/icons-react"
import Link from "next/link"
import { motion } from "framer-motion"
import { cn } from "@/lib/utils"
import type React from "react"
import { useEffect, useRef, useState } from "react"
import dynamic from "next/dynamic"
import { useSearchParams } from "next/navigation"
import { Code, Edit3 } from "lucide-react"
import { Octokit } from "@octokit/rest"

const MonacoEditor = dynamic(() => import("@monaco-editor/react"), { ssr: false })

interface File {
  filename: string
  contents: string
}

interface Project {
  id: string
  name: string
  created: string
  lastModified: string
  files: File[]
  githubRepo?: string
}

const DB_NAME = "CPPProjectsDB"
const DB_VERSION = 1
const STORE_NAME = "projects"

const openDB = () => {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION)

    request.onerror = () => reject(request.error)
    request.onsuccess = () => resolve(request.result)

    request.onupgradeneeded = (event) => {
      const db = (event.target as IDBOpenDBRequest).result
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        const store = db.createObjectStore(STORE_NAME, { keyPath: "id" })
        store.createIndex("name", "name", { unique: false })
        store.createIndex("lastModified", "lastModified", { unique: false })
      }
    }
  })
}

const saveProject = async (project: Project) => {
  const db = await openDB()
  const transaction = db.transaction([STORE_NAME], "readwrite")
  const store = transaction.objectStore(STORE_NAME)
  return new Promise<void>((resolve, reject) => {
    const request = store.put(project)
    request.onsuccess = () => resolve()
    request.onerror = () => reject(request.error)
  })
}

const getProject = async (id: string) => {
  const db = await openDB()
  const transaction = db.transaction([STORE_NAME], "readonly")
  const store = transaction.objectStore(STORE_NAME)
  return new Promise<Project>((resolve, reject) => {
    const request = store.get(id)
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

class CPPCompiler {
  private _initialized = false

  get initialized(): boolean {
    return this._initialized
  }

  private compilerEndpoint = "https://emkc.org/api/v2/piston/execute"

  constructor() {
    this._initialized = true
  }

  async compile(code: string): Promise<{ success: boolean; output: string; compiledCode?: string }> {
    try {
      console.log("Sending code to C++ compiler service...")

      const response = await fetch(this.compilerEndpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({
          language: "c++",
          version: "*",
          files: [
            {
              name: "main.cpp",
              content: code,
            },
          ],
          stdin: "",
          args: [],
          compile_timeout: 10000,
          run_timeout: 3000,
        }),
      })

      if (!response.ok) {
        const errorText = await response.text()
        throw new Error(`Piston API error: ${response.status} ${response.statusText} - ${errorText}`)
      }

      const result = await response.json()

      if (result.compile && result.compile.code !== 0) {
        return {
          success: false,
          output: `Compilation failed:\n${result.compile.stderr || result.compile.stdout || "Unknown compilation error"}`,
        }
      }

      if (result.run && result.run.code !== 0) {
        return {
          success: true,
          output: `Compilation successful!\nRuntime output:\n${result.run.stdout || ""}\nRuntime errors:\n${result.run.stderr || ""}`,
          compiledCode: JSON.stringify(result),
        }
      }

      return {
        success: true,
        output: `Compilation and execution successful!\nOutput:\n${result.run?.stdout || "No output"}`,
        compiledCode: JSON.stringify(result),
      }
    } catch (error) {
      console.error("Piston compilation error:", error)

      try {
        return await this.compileWithWandbox(code)
      } catch (altError) {
        console.error("Wandbox compilation failed:", altError)
        return {
          success: false,
          output: `All compilation services failed:\n1. Piston: ${error}\n2. Wandbox: ${altError}`,
        }
      }
    }
  }

  private async compileWithWandbox(code: string): Promise<{ success: boolean; output: string; compiledCode?: string }> {
    const response = await fetch("https://wandbox.org/api/compile.json", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        compiler: "gcc-head",
        code: code,
        options: "warning,gnu++2a",
        "compiler-option-raw": "-std=c++20 -O2",
        save: false,
      }),
    })

    if (!response.ok) {
      const errorText = await response.text()
      throw new Error(`Wandbox API error: ${response.status} ${response.statusText} - ${errorText}`)
    }

    const result = await response.json()

    if (result.status !== 0) {
      return {
        success: false,
        output: `Compilation failed:\n${result.compiler_error || result.program_error || "Unknown error"}`,
      }
    }

    return {
      success: true,
      output: `Compilation successful! (Wandbox GCC)\nOutput:\n${result.program_output || "No output"}\n${result.compiler_message || ""}`,
      compiledCode: JSON.stringify(result),
    }
  }
}

const Editor = () => {
  const [files, setFiles] = useState<File[]>([
    {
      filename: "main.cpp",
      contents: `#include <iostream>
#include <vector>
#include <string>

int main() {
    std::cout << "Hello from C++ compilation!" << std::endl;
    
    std::vector<int> numbers = {1, 2, 3, 4, 5};
    std::cout << "Numbers: ";
    for(int num : numbers) {
        std::cout << num << " ";
    }
    std::cout << std::endl;
    
    return 0;
}`,
    },
  ])

  const [activeFile, setActiveFile] = useState("main.cpp")
  const [outputLines, setOutputLines] = useState<string[]>([])
  const [compilerLoaded, setCompilerLoaded] = useState(true)
  const outputRef = useRef<HTMLDivElement>(null)
  const [sidebarWidth, setSidebarWidth] = useState(300)
  const isResizing = useRef(false)
  const monacoEditorRef = useRef<any>(null)
  const [open, setOpen] = useState(false)
  const searchParams = useSearchParams()
  const projectId = searchParams.get("projectId") ?? ""
  const [projectData, setProjectData] = useState<Project | null>(null)
  const [loading, setLoading] = useState(true)
  const [outputHeight, setOutputHeight] = useState(200)
  const [githubToken, setGithubToken] = useState<string | null>(null)
  const [showTokenModal, setShowTokenModal] = useState(false)
  const [showCloneModal, setShowCloneModal] = useState(false)
  const [cloneUrl, setCloneUrl] = useState("")
  const [isCompiling, setIsCompiling] = useState(false)

  const compiler = useRef(new CPPCompiler())

  useEffect(() => {
    const token = localStorage.getItem("githubToken")
    if (token) setGithubToken(token)
  }, [])

  useEffect(() => {
    const loadProject = async () => {
      if (!projectId) {
        setLoading(false)
        return
      }

      try {
        const project = await getProject(projectId)
        setProjectData(project)
        setFiles(project.files)
        setActiveFile(project.files[0]?.filename || "main.cpp")
      } catch (error) {
        console.error("Error loading project:", error)
      } finally {
        setLoading(false)
      }
    }

    loadProject()
  }, [projectId])

  const checkToken = () => {
    const token = localStorage.getItem("githubToken")
    if (!token) {
      setShowTokenModal(true)
      return null
    }
    return token
  }

  const handlePush = async () => {
    const token = checkToken()
    if (!token) return

    try {
      const octokit = new Octokit({ auth: token })

      let repoName = projectData?.githubRepo || prompt("Enter GitHub repository name:")
      if (!repoName) return

      if (repoName.includes("/")) {
        repoName = repoName.split("/")[1]
      }

      const { data: user } = await octokit.users.getAuthenticated()
      const owner = user.login

      let repoExists = false
      try {
        await octokit.repos.get({ owner, repo: repoName })
        repoExists = true
        setOutputLines((prev) => [...prev, `Repository ${owner}/${repoName} found, updating files...`])
      } catch (error: any) {
        if (error.status === 404) {
          try {
            await octokit.repos.createForAuthenticatedUser({
              name: repoName,
              private: false,
              description: `C++ Project created with SchoolNest IDE`,
            })
            setOutputLines((prev) => [...prev, `Created new repository: ${owner}/${repoName}`])
            repoExists = true
          } catch (createError: any) {
            if (createError.message.includes("name already exists")) {
              setOutputLines((prev) => [
                ...prev,
                `Repository ${repoName} already exists but is not accessible. Check permissions or try a different name.`,
              ])
              return
            }
            throw createError
          }
        } else {
          throw error
        }
      }

      if (!repoExists) {
        setOutputLines((prev) => [...prev, `Failed to access or create repository: ${repoName}`])
        return
      }

      let successCount = 0
      let errorCount = 0

      for (const file of files) {
        try {
          let sha
          try {
            const { data: existingFile } = await octokit.repos.getContent({
              owner,
              repo: repoName,
              path: file.filename,
            })

            if (Array.isArray(existingFile)) {
              sha = existingFile[0]?.sha
            } else if ("sha" in existingFile) {
              sha = existingFile.sha
            }
          } catch (error) {
            sha = undefined
          }

          const params: any = {
            owner,
            repo: repoName,
            path: file.filename,
            message: sha ? `Update ${file.filename}` : `Add ${file.filename}`,
            content: btoa(unescape(encodeURIComponent(file.contents))),
          }

          if (sha) {
            params.sha = sha
          }

          await octokit.repos.createOrUpdateFileContents(params)
          successCount++
          setOutputLines((prev) => [...prev, `✓ ${sha ? "Updated" : "Added"} ${file.filename}`])
        } catch (fileError: any) {
          errorCount++
          console.error(`Error updating ${file.filename}:`, fileError)
          setOutputLines((prev) => [...prev, `✗ Error with ${file.filename}: ${fileError.message}`])
        }
      }

      if (successCount > 0 && projectData) {
        const updatedProject = {
          ...projectData,
          githubRepo: `${owner}/${repoName}`,
          lastModified: new Date().toISOString(),
        }
        await saveProject(updatedProject)
        setProjectData(updatedProject)
      }

      if (successCount > 0) {
        setOutputLines((prev) => [...prev, `Successfully pushed ${successCount} file(s) to ${owner}/${repoName}`])
        if (errorCount > 0) {
          setOutputLines((prev) => [...prev, `${errorCount} file(s) had errors`])
        }
      } else {
        setOutputLines((prev) => [...prev, `Failed to push files to ${owner}/${repoName}`])
      }
    } catch (error: any) {
      console.error("Push error:", error)
      setOutputLines((prev) => [...prev, `Push error: ${error.message || "Unknown error occurred"}`])

      if (error.message.includes("Bad credentials")) {
        setOutputLines((prev) => [...prev, "Please check your GitHub token and ensure it has the correct permissions"])
      } else if (error.message.includes("Not Found")) {
        setOutputLines((prev) => [
          ...prev,
          "Repository not found. Please check the repository name and your access permissions",
        ])
      }
    }
  }

  const handlePull = async () => {
    const token = checkToken()
    if (!token) return

    let repoName = projectData?.githubRepo
    if (!repoName) {
      repoName = prompt("Enter GitHub repository name (owner/repo):")
      if (!repoName) return
    }

    try {
      const octokit = new Octokit({ auth: token })

      let owner, repo
      if (repoName.includes("/")) {
        ;[owner, repo] = repoName.split("/")
      } else {
        const { data: user } = await octokit.users.getAuthenticated()
        owner = user.login
        repo = repoName
      }

      const { data: contents } = await octokit.repos.getContent({
        owner,
        repo,
        path: "",
      })

      if (Array.isArray(contents)) {
        const newFiles = await Promise.all(
          contents
            .map(async (file: any) => {
              if (file.type === "file") {
                const { data: fileContent } = await octokit.repos.getContent({
                  owner,
                  repo,
                  path: file.path,
                })

                //@ts-ignore
                const content = fileContent.content
                  ? //@ts-ignore
                    atob(fileContent.content.replace(/\s/g, ""))
                  : await (await fetch(file.download_url)).text()

                return {
                  filename: file.name,
                  contents: content,
                }
              }
              return null
            })
            .filter(Boolean),
        )

        setFiles(newFiles)
        setActiveFile(newFiles[0]?.filename || "main.cpp")

        if (projectData) {
          const updatedProject = {
            ...projectData,
            githubRepo: `${owner}/${repo}`,
            lastModified: new Date().toISOString(),
          }
          await saveProject(updatedProject)
          setProjectData(updatedProject)
        }

        setOutputLines((prev) => [...prev, `Successfully pulled ${newFiles.length} file(s) from ${owner}/${repo}`])
      }
    } catch (error: any) {
      setOutputLines((prev) => [...prev, `Pull error: ${error.message}`])
    }
  }

  const handleClone = async () => {
    const token = localStorage.getItem("githubToken")
    if (!cloneUrl) return

    try {
      const match = cloneUrl.match(/github.com[/:](.+?)\/(.+?)(?:\.git)?$/)
      if (!match) throw new Error("Invalid GitHub URL")

      const [_, owner, repo] = match

      const octokit = token ? new Octokit({ auth: token }) : new Octokit()

      const { data: contents } = await octokit.repos.getContent({
        owner,
        repo,
        path: "",
      })

      if (Array.isArray(contents)) {
        const newFiles = await Promise.all(
          contents
            .map(async (file: any) => {
              if (file.type === "file") {
                const { data: fileContent } = await octokit.repos.getContent({
                  owner,
                  repo,
                  path: file.path,
                })
                //@ts-ignore
                const content = fileContent.content
                  ? //@ts-ignore
                    atob(fileContent.content.replace(/\s/g, ""))
                  : await (await fetch(file.download_url)).text()

                return {
                  filename: file.name,
                  contents: content,
                }
              }
              return null
            })
            .filter(Boolean),
        )

        setFiles(newFiles)
        setActiveFile(newFiles[0]?.filename || "main.cpp")

        if (projectData) {
          const updatedProject = {
            ...projectData,
            githubRepo: `${owner}/${repo}`,
            lastModified: new Date().toISOString(),
          }
          await saveProject(updatedProject)
          setProjectData(updatedProject)
        }

        setShowCloneModal(false)
        setCloneUrl("")
        setOutputLines((prev) => [...prev, `Successfully cloned ${newFiles.length} file(s) from ${owner}/${repo}`])
      }
    } catch (error: any) {
      setOutputLines((prev) => [...prev, `Clone error: ${error.message}`])
    }
  }

  const saveProjectToDB = async () => {
    if (!projectData) return

    const updatedProject: Project = {
      ...projectData,
      files: files,
      lastModified: new Date().toISOString(),
    }

    try {
      await saveProject(updatedProject)
      setProjectData(updatedProject)
      setOutputLines((prev) => [...prev, "Project saved successfully!"])
    } catch (error) {
      console.error("Error saving project:", error)
      setOutputLines((prev) => [...prev, "Error saving project!"])
    }
  }

  const handleFileUpload = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    if (!file) return

    const reader = new FileReader()

    reader.onload = (e) => {
      const contents = e.target?.result as string
      const newFile = {
        filename: file.name,
        contents,
      }

      setFiles((prev) => [...prev, newFile])
      setActiveFile(file.name)
    }

    reader.readAsText(file)
  }

  const runCode = async () => {
    if (!compilerLoaded) {
      setOutputLines(["C++ compiler is still loading! Please wait..."])
      return
    }

    setIsCompiling(true)
    setOutputLines([`Compiling ${activeFile}...`])

    try {
      const activeFileContent = files.find((f) => f.filename === activeFile)?.contents || ""
      const result = await compiler.current.compile(activeFileContent)

      if (result.success) {
        setOutputLines((prev) => [...prev, result.output])
      } else {
        setOutputLines((prev) => [...prev, result.output])
      }
    } catch (error: any) {
      setOutputLines((prev) => [...prev, "Runtime error: " + (error?.toString() || "")])
    } finally {
      setIsCompiling(false)
    }
  }

  const handleEditorChange = (value: string | undefined) => {
    if (!value) return
    setFiles((prev) => prev.map((file) => (file.filename === activeFile ? { ...file, contents: value } : file)))
  }

  const addFile = () => {
    const baseName = "file"
    const extension = ".cpp"

    let maxSuffix = 0
    files.forEach((f) => {
      const match = f.filename.match(/^file(\d*)\.cpp$/)
      if (match) {
        const suffix = match[1] ? Number.parseInt(match[1], 10) : 0
        if (suffix >= maxSuffix) {
          maxSuffix = suffix + 1
        }
      }
    })
    const newFileName = `${baseName}${maxSuffix === 0 ? "" : maxSuffix}${extension}`
    setFiles([
      ...files,
      {
        filename: newFileName,
        contents: `#include <iostream>

int main() {
    std::cout << "Hello World!" << std::endl;
    return 0;
}`,
      },
    ])
    setActiveFile(newFileName)
  }

  const removeFile = (fileName: string) => {
    if (files.length === 1) return
    const newFiles = files.filter((f) => f.filename !== fileName)
    setFiles(newFiles)
    if (activeFile === fileName && newFiles.length > 0) {
      setActiveFile(newFiles[0].filename)
    }
  }

  const renameFile = (oldFileName: string, newFileName: string) => {
    if (files.some((f) => f.filename === newFileName)) {
      alert("A file with that name already exists.")
      return
    }
    const updatedFiles = files.map((f) => (f.filename === oldFileName ? { ...f, filename: newFileName } : f))
    setFiles(updatedFiles)
    if (activeFile === oldFileName) {
      setActiveFile(newFileName)
    }
  }

  const handleExport = () => {
    const file = files.find((f) => f.filename === activeFile)
    if (!file) {
      alert("No file selected.")
      return
    }

    const blob = new Blob([file.contents], { type: "text/plain" })
    const url = URL.createObjectURL(blob)

    const a = document.createElement("a")
    a.href = url
    a.download = file.filename
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)

    URL.revokeObjectURL(url)
  }

  const handleEditorDidMount = (editor: any) => {
    monacoEditorRef.current = editor
  }

  const handleMouseDown = (e: React.MouseEvent) => {
    isResizing.current = true
    document.addEventListener("mousemove", handleMouseMove)
    document.addEventListener("mouseup", handleMouseUp)
    document.body.style.userSelect = "none"
  }

  const handleMouseMove = (e: MouseEvent) => {
    if (!isResizing.current) return
    const newWidth = e.clientX - 60
    setSidebarWidth(newWidth)
    e.preventDefault()
    if (monacoEditorRef.current) {
      monacoEditorRef.current.layout()
    }
  }

  const handleMouseUp = () => {
    isResizing.current = false
    document.removeEventListener("mousemove", handleMouseMove)
    document.removeEventListener("mouseup", handleMouseUp)
    document.body.style.userSelect = "auto"
  }

  const Logo = () => {
    return (
      <Link href="/" className="font-normal flex space-x-2 items-center text-sm text-white py-1 relative z-20">
        <div className="h-6 w-6 bg-gradient-to-br from-purple-400 via-purple-500 to-purple-600 rounded-lg shadow-lg shadow-purple-500/30 flex-shrink-0" />
        <motion.span
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          className="font-semibold text-white whitespace-pre bg-gradient-to-r from-purple-400 to-white bg-clip-text text-transparent"
        >
          SchoolNest
        </motion.span>
      </Link>
    )
  }

  const LogoIcon = () => {
    return (
      <Link href="#" className="font-normal flex space-x-2 items-center text-sm text-white py-1 relative z-20">
        <div className="h-6 w-6 bg-gradient-to-br from-purple-400 via-purple-500 to-purple-600 rounded-lg shadow-lg shadow-purple-500/30 flex-shrink-0" />
      </Link>
    )
  }

  const links = [
    {
      label: "Home",
      href: "/studenthome/",
      icon: <IconBrandTabler className="text-slate-400 h-5 w-5 flex-shrink-0" />,
    },
    {
      label: "Profile",
      href: "#",
      icon: <IconUserBolt className="text-slate-400 h-5 w-5 flex-shrink-0" />,
    },
    {
      label: "Dashboard",
      href: "/studenthome/cpp",
      icon: <IconCode className="text-slate-400 h-5 w-5 flex-shrink-0" />,
    },
    {
      label: "Dependencies",
      href: "/studenthome/cpp/dependencies",
      icon: <IconPackage className="text-slate-400 h-5 w-5 flex-shrink-0" />,
    },
    {
      label: "Templates",
      href: "/studenthome/cpp/templates",
      icon: <IconTemplate className="text-slate-400 h-5 w-5 flex-shrink-0" />,
    },
    {
      label: "Account Settings",
      href: "#",
      icon: <IconSettings className="text-slate-400 h-5 w-5 flex-shrink-0" />,
    },
    {
      label: "Logout",
      href: "",
      icon: <IconArrowLeft className="text-slate-400 h-5 w-5 flex-shrink-0" />,
    },
  ]

  if (loading) {
    return (
      <div className="min-h-screen bg-neutral-950 flex items-center justify-center">
        <div className="text-center">
          <IconCode className="h-12 w-12 mx-auto text-purple-500 animate-pulse" />
          <p className="mt-2 text-gray-400">Loading project...</p>
        </div>
      </div>
    )
  }

  return (
    <div
      className={cn(
        "rounded-md flex flex-col md:flex-row bg-black w-full flex-1 border border-slate-800 overflow-auto",
        "h-screen",
      )}
    >
      {/* GitHub Token Modal */}
      {showTokenModal && (
        <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50">
          <div className="bg-white dark:bg-neutral-800 rounded-lg p-6 max-w-md w-full">
            <h3 className="font-bold text-lg mb-4">GitHub Access Token</h3>
            <p className="text-sm text-neutral-600 dark:text-neutral-400 mb-4">
              Create a personal access token with <code>repo</code> scope from GitHub Settings
            </p>
            <input
              type="password"
              placeholder="Enter GitHub Personal Access Token"
              className="w-full p-2 border rounded mb-4 dark:bg-neutral-700 dark:border-neutral-600"
              onChange={(e) => localStorage.setItem("githubToken", e.target.value)}
            />
            <div className="flex justify-end gap-2">
              <button
                className="px-4 py-2 border rounded dark:border-neutral-600"
                onClick={() => setShowTokenModal(false)}
              >
                Cancel
              </button>
              <button
                className="px-4 py-2 bg-purple-500 text-white rounded"
                onClick={() => {
                  setGithubToken(localStorage.getItem("githubToken"))
                  setShowTokenModal(false)
                }}
              >
                Save Token
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Clone Repository Modal */}
      {showCloneModal && (
        <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50">
          <div className="bg-white dark:bg-neutral-800 rounded-lg p-6 max-w-md w-full">
            <h3 className="font-bold text-lg mb-4">Clone Repository</h3>
            <input
              type="text"
              placeholder="https://github.com/user/repo.git"
              className="w-full p-2 border rounded mb-4 dark:bg-neutral-700 dark:border-neutral-600"
              value={cloneUrl}
              onChange={(e) => setCloneUrl(e.target.value)}
            />
            <div className="flex justify-end gap-2">
              <button
                className="px-4 py-2 border rounded dark:border-neutral-600"
                onClick={() => setShowCloneModal(false)}
              >
                Cancel
              </button>
              <button className="px-4 py-2 bg-purple-500 text-white rounded" onClick={handleClone}>
                Clone
              </button>
            </div>
          </div>
        </div>
      )}

      <div
        className="border-r border-neutral-200 dark:border-neutral-700 bg-white dark:bg-neutral-900 backdrop-blur-xl flex flex-col"
        style={{ width: sidebarWidth }}
      >
        <div className="p-6 -mt-2 h-full flex flex-col overflow-hidden">
          <div className="mb-4 flex-shrink-0 font-bold flex items-center gap-2">
            C++ IDE
            {projectData && (
              <span className="text-sm font-normal text-neutral-500 ml-2 truncate">{projectData.name}</span>
            )}
          </div>

          <div
            className="flex-1 overflow-y-auto space-y-2 scrollbar-thin scrollbar-track-transparent scrollbar-thumb-purple-300 dark:scrollbar-thumb-purple-600 hover:scrollbar-thumb-purple-400 dark:hover:scrollbar-thumb-purple-500 scrollbar-thumb-rounded-full pb-4"
            style={{ marginTop: "-12px" }}
          >
            <div className="relative group">
              <button
                className={`w-full text-left px-4 py-3 rounded-lg transition-all duration-200 flex items-center space-x-3 border ${
                  activeFile === "main.cpp"
                    ? "bg-purple-50 dark:bg-purple-900/20 text-purple-700 dark:text-purple-300 border-purple-200 dark:border-purple-700 shadow-sm"
                    : "text-neutral-600 dark:text-neutral-400 hover:bg-neutral-50 dark:hover:bg-neutral-800 border-transparent hover:border-neutral-200 dark:hover:border-neutral-700"
                }`}
                onClick={() => setActiveFile("main.cpp")}
              >
                <div className="w-8 h-8 bg-gradient-to-br from-purple-400 to-purple-600 rounded-lg flex items-center justify-center shadow-sm">
                  <IconCode className="h-4 w-4 text-white" />
                </div>
                <div className="flex flex-col flex-1 min-w-0">
                  <span className="font-mono text-sm font-medium truncate">main.cpp</span>
                  {activeFile === "main.cpp" && (
                    <span className="text-purple-500 dark:text-purple-400 text-xs">Entry point</span>
                  )}
                </div>
              </button>
            </div>

            {files
              .filter((file) => file.filename !== "main.cpp")
              .map((file) => (
                <div key={file.filename} className="relative group">
                  <div className="flex items-center space-x-2">
                    <button
                      className={`flex-1 text-left px-4 py-3 rounded-lg transition-all duration-200 flex items-center space-x-3 border ${
                        activeFile === file.filename
                          ? "bg-purple-50 dark:bg-purple-900/20 text-purple-700 dark:text-purple-300 border-purple-200 dark:border-purple-700 shadow-sm"
                          : "text-neutral-600 dark:text-neutral-400 hover:bg-neutral-50 dark:hover:bg-neutral-800 border-transparent hover:border-neutral-200 dark:hover:border-neutral-700"
                      }`}
                      onClick={() => setActiveFile(file.filename)}
                    >
                      <div className="w-8 h-8 bg-gradient-to-br from-purple-400 to-purple-600 rounded-lg flex items-center justify-center shadow-sm">
                        <Code className="h-4 w-4 text-white" />
                      </div>
                      <span className="font-mono text-sm font-medium truncate flex-1">{file.filename}</span>
                    </button>

                    <div className="flex space-x-1 opacity-0 group-hover:opacity-100 transition-opacity duration-200">
                      <button
                        onClick={() => {
                          const newFileName = prompt("Enter new file name", file.filename)
                          if (newFileName && newFileName !== file.filename) {
                            renameFile(file.filename, newFileName)
                          }
                        }}
                        className="p-2 bg-neutral-100 dark:bg-neutral-800 hover:bg-purple-100 dark:hover:bg-purple-900/40 rounded-lg transition-all duration-200 border border-neutral-200 dark:border-neutral-700 hover:border-purple-300 dark:hover:border-purple-600"
                        title="Rename file"
                      >
                        <Edit3 className="w-3.5 h-3.5 text-neutral-500 dark:text-neutral-400 hover:text-purple-600 dark:hover:text-purple-400" />
                      </button>
                      <button
                        onClick={() => removeFile(file.filename)}
                        className="p-2 bg-neutral-100 dark:bg-neutral-800 hover:bg-red-100 dark:hover:bg-red-900/40 rounded-lg transition-all duration-200 border border-neutral-200 dark:border-neutral-700 hover:border-red-300 dark:hover:border-red-600"
                        title="Delete file"
                      >
                        <IconTrash className="w-3.5 h-3.5 text-neutral-500 dark:text-neutral-400 hover:text-red-600 dark:hover:text-red-400" />
                      </button>
                    </div>
                  </div>
                </div>
              ))}
          </div>

          <div className="space-y-4 flex-shrink-0">
            <div className="grid grid-cols-2 gap-3">
              <button
                className="rounded-lg py-3 px-4 bg-purple-50 dark:bg-purple-900/20 hover:bg-purple-100 dark:hover:bg-purple-900/40 text-purple-700 dark:text-purple-300 font-medium transition-all duration-200 border border-purple-200 dark:border-purple-700 hover:border-purple-300 dark:hover:border-purple-600 disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center space-x-2 active:scale-[0.98]"
                onClick={addFile}
                disabled={!compilerLoaded}
              >
                <IconFileDownload className="w-4 h-4" />
                <span className="text-sm">Add File</span>
              </button>

              <button
                className="rounded-lg py-3 px-4 bg-purple-50 dark:bg-purple-900/20 hover:bg-purple-100 dark:hover:bg-purple-900/40 text-purple-700 dark:text-purple-300 font-medium transition-all duration-200 border border-purple-200 dark:border-purple-700 hover:border-purple-300 dark:hover:border-purple-600 disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center space-x-2 active:scale-[0.98]"
                onClick={runCode}
                disabled={!compilerLoaded || isCompiling}
              >
                <IconPlayerPlayFilled className="w-4 h-4" />
                <span className="text-sm">{isCompiling ? "Compiling..." : "Run File"}</span>
              </button>

              <button
                className="rounded-lg py-3 px-4 bg-purple-50 dark:bg-purple-900/20 hover:bg-purple-100 dark:hover:bg-purple-900/40 text-purple-700 dark:text-purple-300 font-medium transition-all duration-200 border border-purple-200 dark:border-purple-700 hover:border-purple-300 dark:hover:border-purple-600 disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center space-x-2 active:scale-[0.98]"
                onClick={handleExport}
                disabled={!compilerLoaded}
              >
                <IconFolderDown className="w-4 h-4" />
                <span className="text-sm">Export</span>
              </button>

              <label className="rounded-lg py-3 px-4 bg-purple-50 dark:bg-purple-900/20 hover:bg-purple-100 dark:hover:bg-purple-900/40 text-purple-700 dark:text-purple-300 font-medium cursor-pointer transition-all duration-200 border border-purple-200 dark:border-purple-700 hover:border-purple-300 dark:hover:border-purple-600 disabled:opacity-50 flex items-center justify-center space-x-2 active:scale-[0.98]">
                <IconUpload className="w-4 h-4" />
                <span className="text-sm">Load</span>
                <input
                  type="file"
                  accept=".cpp,.h,.hpp,.c"
                  onChange={handleFileUpload}
                  disabled={!compilerLoaded}
                  className="hidden"
                />
              </label>
            </div>

            {/* GitHub Integration Buttons */}
            <div className="mt-4 flex flex-col gap-3">
              <button
                className="rounded-lg py-3 px-4 bg-purple-50 dark:bg-purple-900/20 hover:bg-purple-100 dark:hover:bg-purple-900/40 text-purple-700 dark:text-purple-300 font-medium transition-all duration-200 border border-purple-200 dark:border-purple-700 hover:border-purple-300 dark:hover:border-purple-600 disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center space-x-2 active:scale-[0.98]"
                onClick={handlePush}
                disabled={!compilerLoaded}
              >
                <IconBrandGithub className="w-4 h-4" />
                <span className="text-sm">Push to GitHub</span>
              </button>

              <button
                className="rounded-lg py-3 px-4 bg-purple-50 dark:bg-purple-900/20 hover:bg-purple-100 dark:hover:bg-purple-900/40 text-purple-700 dark:text-purple-300 font-medium transition-all duration-200 border border-purple-200 dark:border-purple-700 hover:border-purple-300 dark:hover:border-purple-600 disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center space-x-2 active:scale-[0.98]"
                onClick={handlePull}
                disabled={!compilerLoaded}
              >
                <IconBrandGithub className="w-4 h-4" />
                <span className="text-sm">Pull from GitHub</span>
              </button>

              <button
                className="rounded-lg py-3 px-4 bg-purple-50 dark:bg-purple-900/20 hover:bg-purple-100 dark:hover:bg-purple-900/40 text-purple-700 dark:text-purple-300 font-medium transition-all duration-200 border border-purple-200 dark:border-purple-700 hover:border-purple-300 dark:hover:border-purple-600 disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center space-x-2 active:scale-[0.98]"
                onClick={() => setShowCloneModal(true)}
                disabled={!compilerLoaded}
              >
                <IconBrandGithub className="w-4 h-4" />
                <span className="text-sm">Clone Repository</span>
              </button>
            </div>

            {/* Save button */}
            <button
              className="w-full rounded-lg py-3 px-4 bg-purple-50 dark:bg-purple-900/20 hover:bg-purple-100 dark:hover:bg-purple-900/40 text-purple-700 dark:text-purple-300 font-medium cursor-pointer transition-all duration-200 border border-purple-200 dark:border-purple-700 hover:border-purple-300 dark:hover:border-purple-600 disabled:opacity-50 flex items-center justify-center space-x-2 active:scale-[0.98]"
              onClick={saveProjectToDB}
              disabled={!compilerLoaded}
            >
              <IconDeviceFloppy className="w-4 h-4" />
              <span className="text-sm">Save Project</span>
            </button>

            {!compilerLoaded && (
              <div className="mt-4 p-4 bg-neutral-50 dark:bg-neutral-800 border border-neutral-200 dark:border-neutral-700 rounded-lg">
                <div className="flex items-center space-x-3">
                  <IconLoader className="h-4 w-4 text-purple-500 animate-spin" />
                  <span className="text-neutral-600 dark:text-neutral-400 text-sm font-medium">
                    Loading C++ Compiler...
                  </span>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

      <div
        className="w-1 h-full bg-neutral-300 dark:bg-neutral-600 cursor-col-resize hover:bg-purple-500 dark:hover:bg-purple-500 transition-all duration-200"
        onMouseDown={handleMouseDown}
      />
      <div className="flex-1 flex flex-col min-w-0">
        <div className="bg-[#1E1E1E]">
          <p
            className="ml-2 font-mono text-white"
            style={{
              fontFamily: "monospace",
            }}
          >
            {activeFile}
          </p>
        </div>
        <div className="flex-1">
          <MonacoEditor
            language="cpp"
            theme="vs-dark"
            value={files.find((f) => f.filename === activeFile)?.contents ?? ""}
            onChange={handleEditorChange}
            options={{ automaticLayout: true }}
            onMount={handleEditorDidMount}
          />
        </div>
        <div
          style={{
            height: "5px",
            cursor: "row-resize",
            backgroundColor: "#ccc",
          }}
        />

        <div
          style={{
            height: "200px",
            borderTop: "1px solid #ccc",
            backgroundColor: "#1e1e1e",
            color: "white",
            fontFamily: "monospace",
            padding: "10px",
            overflowY: "auto",
          }}
          ref={outputRef}
        >
          {outputLines.map((line, index) => (
            <div key={index}>{line}</div>
          ))}
        </div>
      </div>
    </div>
  )
}

export default Editor

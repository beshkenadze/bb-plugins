import { useRef, useState } from "react";
import type { PluginSidebarProject } from "@get-bb/plugin-sdk/app";
import { Button } from "@/components/ui/button";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Icon } from "@/components/ui/icon";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { matchesSearch } from "./model";

const filterByName = (_value: string, search: string, keywords?: string[]) =>
  matchesSearch(keywords?.[0] ?? "", search) ? 1 : 0;

export function ProjectSwitcher({ projects, activeProjectId, onSelect }: {
  /** Already in display order. */
  projects: readonly PluginSidebarProject[];
  activeProjectId: string | null;
  onSelect: (project: PluginSidebarProject) => void;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);
  const active = projects.find((project) => project.id === activeProjectId) ?? null;
  // The phone drawer keeps its content mounted between openings, so clear the search on each one.
  const changeOpen = (next: boolean) => {
    if (next) setSearch("");
    setOpen(next);
  };
  return (
    <Popover open={open} onOpenChange={changeOpen}>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm"
          aria-label={active ? `Switch project (current: ${active.name})` : "Select a project"}
          className="w-full justify-start gap-2 px-2 font-normal">
          <Icon name="Folder" className="text-muted-foreground" />
          <span className={cn("min-w-0 flex-1 truncate text-left", !active && "text-muted-foreground")}>
            {active?.name ?? "Select a project"}
          </span>
          <Icon name="ChevronDown" className="text-muted-foreground" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" aria-label="Projects" mobileTitle="Projects" autoFocusRef={searchRef}
        className="w-(--radix-popover-trigger-width) min-w-56 p-0">
        <Command label="Search projects" loop filter={filterByName}>
          <CommandInput ref={searchRef} placeholder="Search projects…" value={search} onValueChange={setSearch} />
          <CommandList label="Projects">
            <CommandEmpty>No projects found.</CommandEmpty>
            <CommandGroup>
              {projects.map((project) => {
                const current = project.id === activeProjectId;
                return (
                  // cmdk keeps an item's keywords until its value changes; the name in the key remounts it on rename.
                  <CommandItem key={`${project.id}\u0000${project.name}`} value={project.id} keywords={[project.name]}
                    aria-current={current ? "true" : undefined}
                    onSelect={() => {
                      setOpen(false);
                      onSelect(project);
                    }}>
                    <span className="min-w-0 flex-1 truncate">{project.name}</span>
                    {current ? <Icon name="Check" className="text-muted-foreground" /> : null}
                  </CommandItem>
                );
              })}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

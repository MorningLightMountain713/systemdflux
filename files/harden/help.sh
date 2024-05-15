#!/bin/bash

Help()
{
   echo "Available commands"
   echo
   echo "help           This command."
   echo "flux-cli       The fluxd cli."
   echo "fluxbench-cli  The fluxbench cli."
   echo "ip             Configure the network."
   echo "tcpdump        Monitor traffic flows."
   echo "sudo           Only available for the [ip|tcpdump] commands."
   echo "pwd            Show your current directory."
   echo "exit           Exit the shell."
   echo
}

Help

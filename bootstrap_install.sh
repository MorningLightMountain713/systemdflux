#!/bin/bash

if [[ "$EUID" -ne 0 ]]
  then echo "You must run this script as root to install a Fluxnode"
  exit
fi

apt-get install nodejs -y

node install.js CLEAN_INSTALL
